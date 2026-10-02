import { NodeProvider, groupOfAddress, isValidAddress, MINIMAL_CONTRACT_DEPOSIT } from '@alephium/web3'
import type { Account, SignerProvider } from '@alephium/web3'
import type { AlephiumWindowObject } from '@alephium/get-extension-wallet'
import type { DashboardData } from './chain.ts'
import { NODE_URL, EXPLORER_APP_URL, XALPH_VAULT_ADDRESS } from './chain.ts'
import { escapeHtml, formatNumber, formatPercent, shortAddress } from './format.ts'
import { checkStakeFunding, parseStakeAmount, stakeValidation, stakeAmountText, STAKE_FEE_BUFFER } from './stakingAmounts.ts'
import { calculatorUrl } from './ui.ts'

const DEFAULT_REFERRAL_ADDRESS = '3cUqrf1qUEpfYRvFjtRP8y7jD3Ssrgh8PmjyAwVj7g1N3aamsypcY'
const referralAddress = (import.meta.env.VITE_STAKING_REFERRAL_ADDRESS ?? DEFAULT_REFERRAL_ADDRESS).trim()
const provider = new NodeProvider(NODE_URL)
const vaultGroup = groupOfAddress(XALPH_VAULT_ADDRESS)
let wallet: AlephiumWindowObject | undefined
let account: Account | undefined
let available: bigint | undefined
let amountInput = ''
let connecting = false
let signing = false
let error = ''
let transaction: { txId: string; confirmed: boolean } | undefined
let confirmationTimer: number | undefined
let checkingConfirmation = false
let onChange: () => void = () => {}
let onConfirmed: () => void = () => {}

export function connectedStakingAddress(): string | undefined {
  return account?.address
}

export function initializeStaking(change: () => void, confirmed: () => void): void {
  onChange = change
  onConfirmed = confirmed
}

async function refreshBalance(): Promise<void> {
  const currentAddress = account?.address
  if (!currentAddress) return
  const balance = await provider.addresses.getAddressesAddressBalance(currentAddress)
  if (account?.address === currentAddress) available = BigInt(balance.balance) - BigInt(balance.lockedBalance)
}

function clearConnection(): void {
  wallet = undefined
  account = undefined
  available = undefined
  onChange()
}

async function connect(): Promise<void> {
  connecting = true
  error = ''
  onChange()
  try {
    const { getDefaultAlephiumWallet } = await import('@alephium/get-extension-wallet')
    const extension = await getDefaultAlephiumWallet()
    if (!extension) throw new Error('Install the Alephium browser extension wallet, then connect again.')
    const selected = await extension.enable({ networkId: 'mainnet', addressGroup: vaultGroup, onDisconnected: clearConnection })
    if (!selected) throw new Error('Wallet connection was cancelled.')
    if (extension.connectedNetworkId !== 'mainnet' || groupOfAddress(selected.address) !== vaultGroup) {
      throw new Error(`Select an Alephium mainnet address in group ${vaultGroup} in your wallet.`)
    }
    wallet = extension
    account = selected
    await refreshBalance()
  } catch (err) {
    clearConnection()
    error = err instanceof Error ? err.message : 'Unable to connect to the wallet.'
  } finally {
    connecting = false
    onChange()
  }
}

async function checkConfirmation(): Promise<void> {
  if (!transaction || transaction.confirmed || checkingConfirmation) return
  checkingConfirmation = true
  try {
    const status = await provider.transactions.getTransactionsStatus({ txId: transaction.txId })
    if (status.type === 'Confirmed') {
      transaction.confirmed = true
      window.clearInterval(confirmationTimer)
      confirmationTimer = undefined
      amountInput = ''
      available = undefined
      try { await refreshBalance() } catch { /* Confirmation is independent of balance lookup. */ }
      onConfirmed()
      onChange()
    }
  } catch {
    // An RPC failure is not a failed stake: keep it visible, retry, and prevent
    // duplicate submissions while the original transaction is pending.
  } finally {
    checkingConfirmation = false
  }
}

async function submitStake(): Promise<void> {
  if (signing || connecting || (transaction && !transaction.confirmed)) return
  error = ''
  signing = true
  onChange()
  try {
    if (!wallet || !account) throw new Error('Connect your wallet before staking.')
    const signer = wallet
    const expectedAddress = account.address
    const selected = await signer.getSelectedAccount()
    if (signer.connectedNetworkId !== 'mainnet' || groupOfAddress(selected.address) !== vaultGroup || selected.address !== expectedAddress) {
      clearConnection()
      throw new Error('Your wallet account or network changed. Connect again before staking.')
    }
    const amount = parseStakeAmount(amountInput)
    if (referralAddress && !isValidAddress(referralAddress)) throw new Error('Staking is temporarily unavailable due to an app configuration issue.')
    await refreshBalance()
    if (wallet !== signer || account?.address !== expectedAddress || available === undefined) {
      throw new Error('Wallet connection changed. Connect again before staking.')
    }
    checkStakeFunding(amount, available, MINIMAL_CONTRACT_DEPOSIT)
    const { Powfi } = await import('@alephium/powfi-sdk')
    // The extension's CJS declarations and SDK's ESM declarations each resolve
    // the same pinned Web3 SignerProvider, but TS treats their protected members
    // as different classes. The runtime wallet implements this signer API.
    const powfi = Powfi.load({ networkId: 'mainnet', signer: signer as unknown as SignerProvider, networkOverrides: { nodeUrl: NODE_URL } })
    powfi.setCurrentProviders()
    if (powfi.staking.getConfig().xAlphTokenAddress !== XALPH_VAULT_ADDRESS) {
      throw new Error('The SDK staking vault does not match the dashboard vault.')
    }
    const result = referralAddress
      ? await powfi.staking.stakeAlphWithReferral(amount, referralAddress)
      : await powfi.staking.stakeAlph(amount)
    transaction = { txId: result.txId, confirmed: false }
    window.clearInterval(confirmationTimer)
    confirmationTimer = window.setInterval(() => void checkConfirmation(), 5000)
    void checkConfirmation()
  } catch (err) {
    error = err instanceof Error ? err.message : 'The staking transaction could not be submitted.'
  } finally {
    signing = false
    onChange()
  }
}

export function stakingSection(data: DashboardData): string {
  let amount: bigint | undefined
  try { amount = parseStakeAmount(amountInput) } catch { /* Validate on submission. */ }
  const estimate = amount === undefined ? undefined : Number(amount) / 1e18 / data.vault.redemptionRate
  const pending = Boolean(transaction && !transaction.confirmed)
  const invalidReferral = Boolean(referralAddress && !isValidAddress(referralAddress))
  const validation = stakeValidation(amountInput, available, MINIMAL_CONTRACT_DEPOSIT)
  const maxStake = available === undefined ? undefined : available > MINIMAL_CONTRACT_DEPOSIT + STAKE_FEE_BUFFER ? available - MINIMAL_CONTRACT_DEPOSIT - STAKE_FEE_BUFFER : 0n
  const canStake = Boolean(account && amount && available !== undefined && !validation && !signing && !connecting && !pending && !invalidReferral)
  const buttonText = signing ? 'Review in wallet…' : pending ? 'Waiting for confirmation…' : !account ? 'Connect wallet to stake' : available === undefined ? 'Balance unavailable' : validation && amount ? 'Insufficient ALPH' : !amount ? 'Enter an amount' : 'Stake ALPH →'
  return `
    <section class="staking-layout" id="stake" aria-label="Stake ALPH">
      <div class="staking-overview">
        <div class="staking-yield"><span class="eyebrow">CURRENT STAKING YIELD</span><strong>${formatPercent(data.vault.currentAprPct, 2)} <small>APR</small></strong><p>Earn yield through the growing ALPH redemption value of your xALPH.</p><span class="staking-variable">Variable rate · yield is not guaranteed</span></div>
        <div class="staking-details"><h2>How staking works</h2><ol><li><strong>Deposit ALPH</strong><span>Connect your wallet and choose an amount.</span></li><li><strong>Receive xALPH</strong><span>Your liquid token represents your share of the vault.</span></li><li><strong>Earn staking yield</strong><span>Redeem through the vault over 30 days, or swap on the market at the available price.</span></li></ol></div>
        <a class="staking-position-link" href="${calculatorUrl(account?.address)}">Check your position and earned yield <span aria-hidden="true">↗</span></a>
      </div>
      <div class="card staking-card"><div class="staking-card-heading"><span class="eyebrow">LIQUID STAKING</span><h2>Stake ALPH</h2><p>Deposit ALPH. Receive yield-bearing xALPH.</p></div>
        <div class="staking-wallet"><div><strong>${account ? `Connected · ${shortAddress(account.address)}` : 'Your wallet'}</strong><p>${account ? `Available: ${available === undefined ? 'Unable to load balance' : `${formatNumber(Number(available) / 1e18, 4)} ALPH`}` : 'Connect the Alephium browser extension wallet to stake here.'}</p></div><button type="button" class="refresh-btn" id="staking-connect" ${connecting || signing ? 'disabled' : ''}>${connecting ? 'Connecting…' : account ? 'Disconnect' : 'Connect wallet'}</button></div>
        <form id="staking-form" class="staking-form">
          <div><div class="staking-input-heading"><label class="input-label" for="staking-amount">You stake</label><button class="staking-max" id="staking-max" type="button" ${!maxStake || signing || pending ? 'disabled' : ''}>Max</button></div><div class="staking-amount-wrap"><input id="staking-amount" class="addr-input" type="text" inputmode="decimal" value="${escapeHtml(amountInput)}" placeholder="0.00" autocomplete="off" aria-invalid="${Boolean(validation)}" aria-describedby="staking-help staking-validation${error ? ' staking-error' : ''}" ${signing || pending ? 'disabled' : ''}/><span>ALPH</span></div><p class="staking-validation ${validation ? 'is-error' : ''}" id="staking-validation" role="status">${validation ? escapeHtml(validation) : account && maxStake !== undefined ? `Available to stake: ${stakeAmountText(maxStake)} ALPH` : 'Connect your wallet to check your available balance.'}</p></div>
          <div class="staking-quote"><span>You receive · estimated</span><strong>${estimate === undefined ? '—' : formatNumber(estimate, 6)} <small>xALPH</small></strong></div>
          <button type="submit" class="refresh-btn primary-btn" ${!canStake ? 'disabled' : ''}>${buttonText}</button>
        </form>
        <p class="input-help" id="staking-help">Max leaves 0.1 ALPH for transaction funding and a 0.01 ALPH network fee buffer. Your wallet calculates the final fee before you approve.</p>
        <p class="staking-fee">No additional app fee · You approve the transaction in your wallet.</p>
        ${invalidReferral ? '<p class="unstake-error" role="alert">Staking is temporarily unavailable due to an app configuration issue.</p>' : ''}
        ${error ? `<p class="unstake-error" id="staking-error" role="alert">${escapeHtml(error)}</p>` : ''}
        ${transaction ? `<p class="staking-status" role="status">${transaction.confirmed ? '✓ Stake confirmed' : 'Transaction submitted · awaiting confirmation'} · <a href="${EXPLORER_APP_URL}/transactions/${encodeURIComponent(transaction.txId)}" target="_blank" rel="noopener noreferrer">View transaction ↗</a></p>` : ''}
      </div>
    </section>`
}

export function bindStaking(): void {
  document.getElementById('staking-max')?.addEventListener('click', () => {
    if (available === undefined || signing || (transaction && !transaction.confirmed)) return
    const max = available - MINIMAL_CONTRACT_DEPOSIT - STAKE_FEE_BUFFER
    if (max <= 0n) return
    amountInput = stakeAmountText(max)
    error = ''
    onChange()
  })
  document.getElementById('staking-connect')?.addEventListener('click', () => {
    if (wallet) {
      const connected = wallet
      clearConnection()
      void connected.disconnect().catch(() => {})
    } else void connect()
  })
  document.getElementById('staking-amount')?.addEventListener('input', (e) => {
    amountInput = (e.target as HTMLInputElement).value
    error = ''
    onChange()
  })
  document.getElementById('staking-form')?.addEventListener('submit', (e) => {
    e.preventDefault()
    void submitStake()
  })
}
