import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import { createServer } from 'vite'
import { Powfi } from '@alephium/powfi-sdk'
import { MINIMAL_CONTRACT_DEPOSIT, addressToBytes, binToHex, contractIdFromAddress } from '@alephium/web3'

const source = await readFile(new URL('../src/stakingAmounts.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText
const { parseStakeAmount, checkStakeFunding, stakeValidation, stakeAmountText, STAKE_FEE_BUFFER } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

test('ALPH parsing preserves one attoALPH and large decimal amounts exactly', () => {
  assert.equal(parseStakeAmount('0.000000000000000001'), 1n)
  assert.equal(parseStakeAmount('1234567.123456789123456789'), 1234567123456789123456789n)
  assert.equal(parseStakeAmount(' 12.5 '), 12500000000000000000n)
  assert.equal(parseStakeAmount('001'), 1000000000000000000n)
})

test('invalid, zero, negative, exponential and over-precision inputs are rejected', () => {
  for (const input of ['', '0', '0.000', '-1', '1e3', '1,000', 'Infinity', 'NaN', '1.2.3', '0.0000000000000000001']) {
    assert.throws(() => parseStakeAmount(input), undefined, input)
  }
})

test('funding check reserves the SDK-required additional ALPH', () => {
  const stake = parseStakeAmount('10')
  assert.throws(() => checkStakeFunding(stake, stake, MINIMAL_CONTRACT_DEPOSIT))
  assert.doesNotThrow(() => checkStakeFunding(stake, stake + MINIMAL_CONTRACT_DEPOSIT + STAKE_FEE_BUFFER, MINIMAL_CONTRACT_DEPOSIT))
})

test('real SDK builds the expected vault transaction and referral with an inert signer', async () => {
  const referral = '3cUqrf1qUEpfYRvFjtRP8y7jD3Ssrgh8PmjyAwVj7g1N3aamsypcY'
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
    const { calculatorUrl } = await server.ssrLoadModule('/src/ui.ts')
    assert.equal(calculatorUrl(), '/#calculator')
    assert.equal(calculatorUrl('wallet-address'), '/?address=wallet-address#calculator')
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
    assert.doesNotMatch(html, /referral|3cUqrf1qUEpfYRvFjtRP8y7jD3Ssrgh8PmjyAwVj7g1N3aamsypcY/i)
    assert.match(html, /No additional app fee/)
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
