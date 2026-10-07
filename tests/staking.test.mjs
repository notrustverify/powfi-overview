import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import { createServer } from 'vite'
import { Powfi } from '@alephium/powfi-sdk'
import { MINIMAL_CONTRACT_DEPOSIT, addressToBytes, binToHex, contractIdFromAddress } from '@alephium/web3'

const source = await readFile(new URL('../src/stakingAmounts.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText
const { parseStakeAmount, checkStakeFunding, stakeValidation, stakeAmountText, formatStakeInput, STAKE_FEE_BUFFER } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

test('ALPH parsing preserves one attoALPH and large decimal amounts exactly', () => {
  assert.equal(parseStakeAmount('0.000000000000000001'), 1n)
  assert.equal(parseStakeAmount('1234567.123456789123456789'), 1234567123456789123456789n)
  assert.equal(parseStakeAmount(' 12.5 '), 12500000000000000000n)
  assert.equal(parseStakeAmount('001'), 1000000000000000000n)
})

test('invalid, zero, negative, exponential and over-precision inputs are rejected', () => {
  for (const input of ['', '0', '0.000', '-1', '1e3', '1,5', '12,34', 'Infinity', 'NaN', '1.2.3', '0.0000000000000000001']) {
    assert.throws(() => parseStakeAmount(input), undefined, input)
  }
})

test('grouped staking amounts preserve precision and unfinished decimals', () => {
  assert.equal(formatStakeInput('1234567.123456789123456789'), '1,234,567.123456789123456789')
  assert.equal(parseStakeAmount('1,234,567.123456789123456789'), parseStakeAmount('1234567.123456789123456789'))
  assert.equal(formatStakeInput('1000.'), '1,000.')
  assert.equal(formatStakeInput('1000.00'), '1,000.00')
  assert.equal(formatStakeInput('1,5'), '1,5')
})

test('funding check reserves the SDK-required additional ALPH', () => {
  const stake = parseStakeAmount('10')
  assert.throws(() => checkStakeFunding(stake, stake, MINIMAL_CONTRACT_DEPOSIT))
  assert.doesNotThrow(() => checkStakeFunding(stake, stake + MINIMAL_CONTRACT_DEPOSIT + STAKE_FEE_BUFFER, MINIMAL_CONTRACT_DEPOSIT))
})

test('real SDK builds the expected vault transaction and referral with an inert signer', async () => {
  const referral = '3cUsjeBfMTggytagJXCsvyhtYPy5HydRePWftyE4WBuXSvGvNR2k7'
  const vault = '225WevmFp5ZgzPsyVJTvyp2v2uyKrvp329HfrVmzffnWj'
  const caller = '15y5UYQbTbeDHx9YtCHaKH95uEji2S3vTRyoeo9hsuC1'
  const calls = []
  // Captures unsigned execution parameters; cannot sign or send a transaction.
  const signer = {
    getSelectedAccount: async () => ({ address: caller, keyType: 'default', group: 0, publicKey: '' }),
    signAndSubmitExecuteScriptTx: async (params) => {
      calls.push(params)
      return { txId: '0'.repeat(64) }
    },
  }
  const sdk = Powfi.load({ networkId: 'mainnet', signer })
  assert.equal(sdk.staking.getConfig().xAlphTokenAddress, vault)
  const amount = parseStakeAmount('100.000000000000000001')
  await sdk.staking.stakeAlphWithReferral(amount, referral)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].attoAlphAmount, amount + MINIMAL_CONTRACT_DEPOSIT)
  assert.equal(calls[0].group, 0)
  assert.equal(calls[0].signerAddress, caller)
  assert.equal(calls[0].tokens, undefined)
  assert.ok(calls[0].bytecode.includes(binToHex(contractIdFromAddress(vault))))
  assert.ok(calls[0].bytecode.includes(binToHex(addressToBytes(referral))))
  await assert.rejects(sdk.staking.stakeAlphWithReferral(0n, referral))
  assert.equal(calls.length, 1)
})

test('staking form disables submission before connection and displays quote without referral attribution', async () => {
  const server = await createServer({ server: { middlewareMode: true, ws: false, hmr: false, watch: null } })
  const previousDocument = globalThis.document
  try {
    const staking = await server.ssrLoadModule('/src/staking.ts')
    const { calculatorUrl, calculatorAddressFromUrl } = await server.ssrLoadModule('/src/ui.ts')
    const { decodeStakingEvent, XALPH_VAULT_ADDRESS } = await server.ssrLoadModule('/src/chain.ts')
    const referral = '3cUsjeBfMTggytagJXCsvyhtYPy5HydRePWftyE4WBuXSvGvNR2k7'
    const stakeEvent = (address) => ({ txHash: 'test', timestamp: 0, eventIndex: 0, fields: [
      { value: referral }, { value: address }, { value: '1000000000000000000' }, { value: '1000000000000000000' },
    ] })
    assert.equal(decodeStakingEvent(stakeEvent(referral)).referralAddress, referral)
    assert.equal(decodeStakingEvent(stakeEvent(XALPH_VAULT_ADDRESS)).referralAddress, undefined)
    assert.equal(decodeStakingEvent(stakeEvent('')).referralAddress, undefined)
    assert.equal(calculatorUrl(), '/#calculator')
    assert.equal(calculatorUrl('wallet-address'), '/#calculator?address=wallet-address')
    for (const path of ['/#calculator?address=wallet-address', '/#calculator?address=wallet-address#calculator', '/?address=wallet-address#calculator']) {
      assert.equal(calculatorAddressFromUrl(new URL(path, 'https://example.com')), 'wallet-address')
    }
    const data = { vault: { currentAprPct: 10, redemptionRate: 2 } }
    const handlers = new Map()
    globalThis.document = {
      getElementById: (id) => ({ addEventListener: (kind, handler) => handlers.set(`${id}:${kind}`, handler) }),
    }
    staking.bindStaking()
    handlers.get('staking-amount:input')({ target: { value: '100' } })
    const html = staking.stakingSection(data)
    assert.match(html, /Stake ALPH/)
    assert.match(html, /type="submit"[^>]*disabled/)
    assert.match(html, /<strong>50 <small>xALPH<\/small><\/strong>/)
    assert.doesNotMatch(html, /referral|3cUsjeBfMTggytagJXCsvyhtYPy5HydRePWftyE4WBuXSvGvNR2k7/i)
    assert.match(html, /No additional app fee/)
    const input = { value: '1,0234.50', selectionStart: 3, selectionEnd: 3, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end } }
    handlers.get('staking-amount:input')({ target: input, inputType: 'insertText' })
    assert.equal(input.value, '10,234.50')
    assert.equal(input.selectionStart, 2)
    assert.match(staking.stakingSection(data), /value="10,234.50"/)
    assert.match(staking.stakingSection(data), /<strong>5,117.25 <small>xALPH/)
    handlers.get('staking-amount:input')({ target: { value: '1e3' } })
    assert.match(staking.stakingSection(data), /<strong>— <small>xALPH<\/small><\/strong>/)
    assert.match(staking.stakingSection(data), /aria-invalid="true"/)
  } finally {
    globalThis.document = previousDocument
    await server.close()
  }
})

test('live balance validation includes funding and fee buffer, with exact max amounts', () => {
  const balance = parseStakeAmount('10.11')
  assert.equal(stakeValidation('10', balance, MINIMAL_CONTRACT_DEPOSIT), '')
  assert.match(stakeValidation('10.000000000000000001', balance, MINIMAL_CONTRACT_DEPOSIT), /Not enough ALPH/)
  assert.match(stakeValidation('0', balance, MINIMAL_CONTRACT_DEPOSIT), /greater than zero/)
  assert.equal(stakeAmountText(balance - MINIMAL_CONTRACT_DEPOSIT - STAKE_FEE_BUFFER), '10')
  assert.equal(stakeAmountText(1n), '0.000000000000000001')
})

test('pending unstake totals exclude partial withdrawals and reuse configured providers', async () => {
  const server = await createServer({ server: { middlewareMode: true, ws: false, hmr: false, watch: null } })
  const originalLoad = Powfi.load
  let loadConfig
  let providerRestores = 0
  try {
    Powfi.load = (config) => {
      loadConfig = config
      return {
        setCurrentProviders: () => providerRestores++,
        staking: {
          getActiveUnstakeVaultIndexes: async () => [1n, 2n],
          getAlphUnstakeVaultState: async (_address, index) => ({ fields: {
            totalUnstakeAmount: parseStakeAmount('100'),
            withdrawnAmount: index === 1n ? parseStakeAmount('40') : 0n,
            unstakeStartTime: 1000n,
            unstakeDuration: 2000n,
          } }),
          getClaimableAmount: async () => parseStakeAmount('10'),
        },
      }
    }
    const { fetchPendingUnstakes } = await server.ssrLoadModule('/src/xalphPositions.ts')
    const { NODE_URL, EXPLORER_API_URL } = await server.ssrLoadModule('/src/chain.ts')
    const pending = await fetchPendingUnstakes('test-address')
    assert.deepEqual(pending.map((request) => request.remainingUnstakeAmount), [60, 100])
    assert.equal(pending[0].claimableNow, 10)
    assert.equal(pending[0].claimableAt, 3000)
    assert.deepEqual(loadConfig, { networkId: 'mainnet', networkOverrides: { nodeUrl: NODE_URL, explorerUrl: EXPLORER_API_URL } })
    assert.equal(providerRestores, 0, 'load registers providers automatically')
    await fetchPendingUnstakes('test-address')
    assert.equal(providerRestores, 1, 'a reused instance restores its provider context')
  } finally {
    Powfi.load = originalLoad
    await server.close()
  }
})

test('reconnect reopens the chooser only after provider disconnection finishes', async () => {
  const previousDocument = globalThis.document
  const previousFetch = globalThis.fetch
  const handlers = new Map()
  let finishDisconnect
  let disconnectFails = false
  let showCount = 0
  const address = '15y5UYQbTbeDHx9YtCHaKH95uEji2S3vTRyoeo9hsuC1'
  globalThis.document = { getElementById: (id) => ({ addEventListener: (kind, handler) => handlers.set(`${id}:${kind}`, handler) }) }
  globalThis.fetch = async () => new Response(JSON.stringify({ balance: '10000000000000000000', lockedBalance: '0' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  const server = await createServer({ server: { middlewareMode: true, ws: false, hmr: false, watch: null } })
  const waitUntil = async (predicate) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.fail('Wallet state transition did not finish')
  }
  try {
    const staking = await server.ssrLoadModule('/src/staking.ts')
    const data = { vault: { currentAprPct: 10, redemptionRate: 1 } }
    const html = () => staking.stakingSection(data)
    staking.initializeStaking(() => staking.bindStaking(), () => {})
    staking.setStakingWalletActions({
      show: () => showCount++,
      disconnect: () => disconnectFails ? Promise.reject(new Error('Disconnect failed')) : new Promise((resolve) => { finishDisconnect = resolve }),
    })
    staking.bindStaking()
    const click = () => handlers.get('staking-connect:click')()
    click()
    assert.equal(showCount, 1)
    staking.updateStakingWallet({ connectionStatus: 'connected', account: { address, network: 'mainnet' }, signer: {} })
    await waitUntil(() => html().includes('Available: 10 ALPH'))
    click()
    assert.match(html(), /disabled>Disconnecting…/)
    staking.updateStakingWallet({ connectionStatus: 'disconnected' })
    click()
    assert.equal(showCount, 1)
    finishDisconnect()
    await waitUntil(() => !html().includes('Disconnecting…'))
    click()
    assert.equal(showCount, 2)
    staking.updateStakingWallet({ connectionStatus: 'connected', account: { address, network: 'mainnet' }, signer: {} })
    await waitUntil(() => html().includes('Available: 10 ALPH'))
    disconnectFails = true
    click()
    await waitUntil(() => html().includes('Disconnect failed'))
    assert.equal(staking.connectedStakingAddress(), address)
    assert.doesNotMatch(html(), /Disconnecting…/)
  } finally {
    globalThis.document = previousDocument
    globalThis.fetch = previousFetch
    await server.close()
  }
})
