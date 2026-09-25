import { ALPH_TOKEN_ID } from '@alephium/web3'
import './style.css'
import {
  fetchDashboardData,
  fetchAddressXalphBalance,
  isAlephiumAddress,
  xalphMarketRate,
  TARGETS,
  XALPH_VAULT_ADDRESS,
  XALPH_TOKEN_ID,
  POOL_ALPH_USDT_ADDRESS,
  POOL_XALPH_ALPH_ADDRESS,
  EXPLORER_APP_URL,
} from './chain.ts'
import type { DashboardData, PoolData } from './chain.ts'
// Loaded via dynamic import() in checkUnstake() — pulls in @alephium/powfi-sdk
// (~200KB gzipped), so it only loads when the calculator is actually used.
import type { PendingUnstake, LpPosition } from './xalphPositions.ts'
import {
  formatCompact,
  formatUsd,
  formatNumber,
  formatPercent,
  formatCountdown,
  clampPct,
  shortAddress,
  relativeTime,
  escapeHtml,
} from './format.ts'
import { themeToggleButton, bindThemeToggle, logoUrl } from './theme.ts'

const REFRESH_INTERVAL_MS = 120_000
const POWFI_URL = 'https://powfi.alephium.org'
const POWFI_FAQ_URL = 'https://docs.alephium.org/powfi/faq'
// xALPH -> ALPH swap, prefilled — for "check the real quote yourself" in the unstake calculator.
const POWFI_XALPH_TO_ALPH_SWAP_URL = `https://powfi.alephium.org/swap/?inputMint=${XALPH_TOKEN_ID}&outputMint=${ALPH_TOKEN_ID}`

const app = document.querySelector<HTMLDivElement>('#app')!

let data: DashboardData | null = null
let errorMessage: string | null = null
let loading = true
let advancedOpen = false

interface UnstakeResult {
  address: string
  xalphBalance: number
  lpPositions: LpPosition[]
  pendingUnstakes: PendingUnstake[]
  alphAtRedemption: number
  alphAtMarket: number
  deviationPct: number
  stakingYieldAlph: number
}

const RECENT_ADDRESSES_STORAGE_KEY = 'powfi-recent-unstake-addresses'
const MAX_RECENT_ADDRESSES = 3

function loadRecentAddresses(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_ADDRESSES_STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === 'string').slice(0, MAX_RECENT_ADDRESSES) : []
  } catch {
    return [] // localStorage unavailable (private mode etc.) or corrupt data
  }
}

function saveRecentAddress(address: string): void {
  try {
    const next = [address, ...recentAddresses.filter((a) => a !== address)].slice(0, MAX_RECENT_ADDRESSES)
    recentAddresses = next
    localStorage.setItem(RECENT_ADDRESSES_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // localStorage unavailable — recent addresses just won't be remembered.
  }
}

let recentAddresses = loadRecentAddresses()
let unstakeAddress = recentAddresses[0] ?? ''
let unstakeLoading = false
let unstakeError: string | null = null
let unstakeResult: UnstakeResult | null = null

function progressCard(current: string, currentRaw: number, target: number, targetLabel: string, label: string, full = false): string {
  const pct = target > 0 ? (currentRaw / target) * 100 : 0
  return `
    <div class="card progress-card${full ? ' full' : ''}">
      <div class="row">
        <span class="value">${current}</span>
        <span class="target">of ${targetLabel} target</span>
      </div>
      <div class="bar-track"><div class="bar-fill" style="width:${clampPct(pct)}%"></div></div>
      <div class="foot"><span>${label} · ${formatPercent(pct, 1)} of target</span><span>${pct < 100 ? 'below target — bonus rate applies' : 'target reached'}</span></div>
    </div>
  `
}

function infoRow(label: string, value: string): string {
  return `<div class="reserve-row"><span class="sym">${label}</span><span class="amt">${value}</span></div>`
}

function reserveList(pool: PoolData): string {
  const rows = [
    { sym: 'ALPH', amt: pool.alphReserve },
    ...pool.tokenReserves.map((r) => ({ sym: r.meta.symbol, amt: r.amount })),
  ]
  return `
    <div class="reserve-list">
      ${rows
        .map(
          (r) => `<div class="reserve-row"><span class="sym">${r.sym} reserve</span><span class="amt">${formatNumber(r.amt, 4)}</span></div>`,
        )
        .join('')}
    </div>
  `
}

function explorerAddrUrl(addr: string): string {
  return `${EXPLORER_APP_URL}/addresses/${addr}`
}

function unstakeResultHtml(r: UnstakeResult): string {
  const flat = Math.abs(r.deviationPct) < 0.01
  const marketIsBetter = r.deviationPct > 0
  const lpXalph = r.lpPositions.reduce((s, p) => s + p.xalphAmount, 0)
  const pendingAlph = r.pendingUnstakes.reduce((s, p) => s + p.totalUnstakeAmount, 0)
  const pendingClaimableNow = r.pendingUnstakes.reduce((s, p) => s + p.claimableNow, 0)

  return `
    <div class="unstake-result">
      <div class="reserve-row"><span class="sym">xALPH held (idle)</span><a class="amt addr-link" href="${explorerAddrUrl(r.address)}" target="_blank" rel="noopener">${formatNumber(r.xalphBalance, 6)}</a></div>
      ${
        r.lpPositions.length > 0
          ? `<div class="reserve-row"><span class="sym">xALPH in LP (${r.lpPositions.length} position${r.lpPositions.length === 1 ? '' : 's'})</span><span class="amt">${formatNumber(lpXalph, 6)}</span></div>`
          : ''
      }
      ${
        r.pendingUnstakes.length > 0
          ? `<div class="reserve-row"><span class="sym">Pending unstake (${r.pendingUnstakes.length} request${r.pendingUnstakes.length === 1 ? '' : 's'})</span><span class="amt">${formatNumber(pendingAlph, 6)} ALPH <small class="activity-claim-date">(${formatNumber(pendingClaimableNow, 4)} claimable now)</small></span></div>`
          : ''
      }
      <div class="reserve-row"><span class="sym">Staking yield earned so far</span><span class="amt" style="color:${r.stakingYieldAlph > 0 ? 'var(--good)' : 'inherit'}">+${formatNumber(r.stakingYieldAlph, 6)} ALPH</span></div>
      <div class="reserve-row"><span class="sym">Unstake + claim everything (vault rate)</span><span class="amt">${formatNumber(r.alphAtRedemption, 6)} ALPH</span></div>
      <div class="reserve-row"><span class="sym">Swap the xALPH instead (pool quote, fees + slippage incl.)</span><span class="amt">${formatNumber(r.alphAtMarket, 6)} ALPH</span></div>
      <div class="reserve-row"><span class="sym">Market vs. redemption</span><span class="amt" style="color:${flat ? 'inherit' : marketIsBetter ? 'var(--good)' : 'var(--warn)'}">${r.deviationPct >= 0 ? '+' : ''}${formatNumber(r.deviationPct, 3)}%</span></div>
      <p class="adv-caveat">Totals include the xALPH side of any liquidity provided to the xALPH × ALPH pool (valued at the current pool price and tick range — the ALPH side of those positions isn't counted here) and any pending unstake requests already in the 30-day cooldown. Both would need to be withdrawn/claimed separately first.</p>
      <p class="adv-caveat">The swap figure is a simulated quote for indication only — it can shift before you actually trade. Get the real, live quote at <a href="${POWFI_XALPH_TO_ALPH_SWAP_URL}" target="_blank" rel="noopener">powfi.alephium.org/swap</a>.</p>
    </div>
  `
}

function unstakeSection(): string {
  const body = unstakeResult
    ? unstakeResultHtml(unstakeResult)
    : `<p class="note" style="margin:0">Enter an address holding xALPH to compare unstaking (vault redemption rate) against swapping on the xALPH × ALPH pool (market price).</p>`
  return `
    <section class="block" id="calculator">
      <div class="block-head">
        <h2>Unstake calculator. <a class="anchor-link" href="#calculator" aria-label="Link to this section" title="Link to this section">#</a></h2>
      </div>
      <div class="card unstake-card">
        <form id="unstake-form" class="unstake-form">
          <div class="addr-input-wrap">
            <input
              id="unstake-address"
              class="addr-input"
              type="text"
              placeholder="Alephium address holding xALPH"
              value="${escapeHtml(unstakeAddress)}"
              autocomplete="off"
              spellcheck="false"
            />
            <button type="button" class="addr-input-clear" id="unstake-address-clear" aria-label="Clear address" title="Clear">✕</button>
          </div>
          <button type="submit" class="refresh-btn" ${unstakeLoading ? 'disabled' : ''}>${unstakeLoading ? 'Checking…' : 'Check'}</button>
        </form>
        ${
          recentAddresses.length > 0
            ? `<div class="filter-bar">
                ${recentAddresses
                  .map(
                    (a) =>
                      `<button type="button" class="filter-btn recent-addr-btn" data-address="${escapeHtml(a)}" title="${escapeHtml(a)}">${shortAddress(a)}</button>`,
                  )
                  .join('')}
              </div>`
            : ''
        }
        ${unstakeError ? `<p class="unstake-error">${escapeHtml(unstakeError)}</p>` : ''}
        ${body}
      </div>
    </section>
  `
}

function stakedTweetUrl(alphStaked: number, circulatingPct: number): string {
  const text = `${formatCompact(alphStaked)} $ALPH is now staked in @alephium's PowFi, ${formatPercent(circulatingPct, 2)} of circulating ALPH supply.`
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`
}

function render(): void {
  const bannerHtml = errorMessage
    ? `<div class="banner">Live data temporarily unavailable (${errorMessage}). ${data ? 'Showing last known values.' : ''}</div>`
    : ''

  if (!data) {
    app.innerHTML = `
      <div class="page">
        ${header()}
        ${bannerHtml}
        <p class="skeleton" style="text-align:center">${loading ? 'Loading live on-chain data…' : 'No data available.'}</p>
      </div>
    `
    return
  }

  const d = data
  const stakedPct = (d.vault.alphStaked / d.circulatingAlph) * 100
  const poolUsdtTvl = d.poolAlphUsdt.price.tvlUsd
  const poolXalphTvl = d.poolXalphAlph.price.tvlUsd

  const xalphSpotRate = xalphMarketRate(d)
  const xalphPegDeviationPct = ((xalphSpotRate - d.vault.redemptionRate) / d.vault.redemptionRate) * 100

  app.innerHTML = `
    <div class="page">
      ${header()}
      ${bannerHtml}

      <section class="block">
        <div class="block-head">
          <h2>Campaign targets: overview.</h2>
          <a class="share-btn" href="${stakedTweetUrl(d.vault.alphStaked, stakedPct)}" target="_blank" rel="noopener">Share on 𝕏</a>
        </div>
        <div class="grid">
          ${progressCard(`${formatCompact(d.vault.alphStaked)} ALPH`, d.vault.alphStaked, TARGETS.stakedAlph, `${formatCompact(TARGETS.stakedAlph)} ALPH`, 'ALPH staked')}
          ${progressCard(formatPercent(stakedPct, 2), stakedPct, TARGETS.stakingShareOfCirculatingPct, `${formatPercent(TARGETS.stakingShareOfCirculatingPct, 0)}`, 'of circulating ALPH')}
        </div>
        <p class="note">*While staking sits below target, APY will be significantly higher.</p>
      </section>

      <section class="block">
        <div class="block-head">
          <h2>ALPH × USDT farming: overview.</h2>
        </div>
        <div class="grid">
          ${progressCard(formatUsd(poolUsdtTvl), poolUsdtTvl, TARGETS.poolTvlUsd, formatUsd(TARGETS.poolTvlUsd), 'Pool TVL', true)}
        </div>
        <p class="note">*While TVL sits below target, early LPs can earn substantially higher APYs.</p>
      </section>

      ${unstakeSection()}

      <details class="advanced" ${advancedOpen ? 'open' : ''}>
        <summary>Advanced recap<span class="chevron">▾</span></summary>
        <div class="advanced-body">
          <div class="adv-group">
            <h3>Campaign parameters</h3>
            ${infoRow('Staking target APY', formatPercent(TARGETS.stakingApyPct, 0))}
            ${infoRow('Farming target APY', formatPercent(TARGETS.poolApyPct, 0))}
            ${infoRow('Active liquidity', 'In range only')}
            ${infoRow('Liquidity type', '2-sided required')}
            ${infoRow('Re-evaluation', 'Monthly')}
            ${infoRow('xALPH', 'Liquid staked ALPH')}
            ${infoRow('Reward source', 'DEX fees + campaign incentives')}
            ${infoRow('Unstake lock-up', '30 days (linear claim)')}
          </div>
          <div class="adv-group">
            <h3>Staking detail</h3>
            <div class="reserve-row"><span class="sym">Current APR (7d avg)</span><span class="amt">${formatPercent(d.vault.currentAprPct, 2)}</span></div>
            <div class="reserve-row"><span class="sym">ALPH staked (exact)</span><span class="amt">${formatNumber(d.vault.alphStaked, 4)}</span></div>
            <div class="reserve-row"><span class="sym">xALPH issued</span><span class="amt">${formatNumber(d.vault.xalphIssued, 4)}</span></div>
            <div class="reserve-row"><span class="sym">Redemption rate</span><span class="amt">${formatNumber(d.vault.redemptionRate, 8)} ALPH / xALPH</span></div>
            ${d.vault.aprIsPartial ? '<p class="adv-caveat">APR is still building up a full 7-day window of data — early reading.</p>' : ''}
          </div>
          <div class="adv-group">
            <h3>ALPH × USDT pool</h3>
            ${reserveList(d.poolAlphUsdt.reserves)}
            <div class="reserve-row"><span class="sym">Spot price (pool)</span><span class="amt">$${formatNumber(d.poolAlphUsdt.price.price1Per0, 4)}</span></div>
            <div class="reserve-row"><span class="sym">Spot price (CoinGecko)</span><span class="amt">$${formatNumber(d.alphPriceUsd, 4)}</span></div>
            <div class="reserve-row"><span class="sym">Trading fee</span><span class="amt">${formatPercent(d.poolAlphUsdt.price.feeRatePct, 2)}</span></div>
            <p class="adv-caveat">Spot price is read from the pool's current tick, pre-fee — not the same as raw reserve ratio, which is meaningless for a concentrated-liquidity pool.</p>
          </div>
          <div class="adv-group">
            <h3>xALPH × ALPH pool</h3>
            ${reserveList(d.poolXalphAlph.reserves)}
            <div class="reserve-row"><span class="sym">Pool TVL</span><span class="amt">${formatUsd(poolXalphTvl)}</span></div>
            <div class="reserve-row"><span class="sym">Spot price (pool)</span><span class="amt">1 xALPH ≈ ${formatNumber(xalphSpotRate, 6)} ALPH</span></div>
            <div class="reserve-row"><span class="sym">vs. redemption rate</span><span class="amt">${xalphPegDeviationPct >= 0 ? '+' : ''}${formatNumber(xalphPegDeviationPct, 2)}%</span></div>
            <div class="reserve-row"><span class="sym">Trading fee</span><span class="amt">${formatPercent(d.poolXalphAlph.price.feeRatePct, 2)}</span></div>
            <p class="adv-caveat">Spot price is read from the pool's current tick, pre-fee — actual swap output will be slightly lower after the trading fee and any price impact.</p>
          </div>
          <div class="adv-group">
            <h3>Contracts</h3>
            <div class="reserve-row"><span class="sym">xALPH vault</span><a class="amt addr-link" href="${explorerAddrUrl(XALPH_VAULT_ADDRESS)}" target="_blank" rel="noopener">${shortAddress(XALPH_VAULT_ADDRESS)}</a></div>
            <div class="reserve-row"><span class="sym">ALPH/USDT pool</span><a class="amt addr-link" href="${explorerAddrUrl(POOL_ALPH_USDT_ADDRESS)}" target="_blank" rel="noopener">${shortAddress(POOL_ALPH_USDT_ADDRESS)}</a></div>
            <div class="reserve-row"><span class="sym">xALPH/ALPH pool</span><a class="amt addr-link" href="${explorerAddrUrl(POOL_XALPH_ALPH_ADDRESS)}" target="_blank" rel="noopener">${shortAddress(POOL_XALPH_ALPH_ADDRESS)}</a></div>
          </div>
        </div>
      </details>

      <footer>
        <span id="last-updated">Updated ${relativeTime(d.fetchedAt)}</span>
        <span style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span>ALPH ${formatUsd(d.alphPriceUsd, 4)} · circulating supply ${formatCompact(d.circulatingAlph)} ALPH · data via node.mainnet.alephium.org &amp; CoinGecko</span>
          <a href="${POWFI_URL}" target="_blank" rel="noopener">powfi.alephium.org ↗</a>
          <a href="${POWFI_FAQ_URL}" target="_blank" rel="noopener">FAQ ↗</a>
          <button class="refresh-btn" id="refresh-btn" ${loading ? 'disabled' : ''}>${loading ? 'Refreshing…' : 'Refresh'}</button>
        </span>
      </footer>
    </div>
  `

  document.getElementById('refresh-btn')?.addEventListener('click', () => void load())
  document.querySelector('.advanced')?.addEventListener('toggle', (e) => {
    advancedOpen = (e.target as HTMLDetailsElement).open
  })
  document.getElementById('unstake-form')?.addEventListener('submit', (e) => {
    e.preventDefault()
    const input = document.getElementById('unstake-address') as HTMLInputElement | null
    void checkUnstake(input?.value ?? '')
  })
  document.querySelectorAll<HTMLButtonElement>('.recent-addr-btn').forEach((btn) => {
    btn.addEventListener('click', () => void checkUnstake(btn.dataset.address ?? ''))
  })
  document.getElementById('unstake-address-clear')?.addEventListener('click', () => {
    const input = document.getElementById('unstake-address') as HTMLInputElement | null
    if (input) {
      input.value = ''
      input.focus()
    }
  })
  bindThemeToggle(render)
  scrollToHashOnce()
  tick()
}

// The calculator section only exists once live data has loaded, so a plain
// #calculator link can arrive before the browser's own anchor-scroll
// has anything to land on. Do it ourselves, once, the first time the target
// element actually appears in the DOM.
let scrolledToHash = false
function scrollToHashOnce(): void {
  if (scrolledToHash || !window.location.hash) return
  const target = document.getElementById(window.location.hash.slice(1))
  if (!target) return
  target.scrollIntoView({ block: 'start' })
  scrolledToHash = true
}

function tick(): void {
  const lastUpdatedEl = document.getElementById('last-updated')
  const nextRefreshEl = document.getElementById('next-refresh')
  if (!data || !lastUpdatedEl || !nextRefreshEl) return

  lastUpdatedEl.textContent = `Updated ${relativeTime(data.fetchedAt)}`

  const remainingMs = data.fetchedAt + REFRESH_INTERVAL_MS - Date.now()
  nextRefreshEl.textContent = loading ? '…' : `in ${formatCountdown(Math.ceil(remainingMs / 1000))}`
}

function header(): string {
  return `
    <div class="topbar">
      <a href="${POWFI_URL}" target="_blank" rel="noopener" title="powfi.alephium.org"><img class="logo-mark" src="${logoUrl()}" alt="Alephium" /></a>
      <div style="display:flex;align-items:center;gap:10px">
        <a class="nav-link" href="${import.meta.env.BASE_URL}activity">Activity</a>
        ${themeToggleButton()}
        <span class="pill">Round 0</span>
      </div>
    </div>
    <div class="hero">
      <span class="pill">Live · Alephium mainnet</span>
      <h1>PowFi <span class="accent">Round 0</span> goals.</h1>
      <p>Tracking the ALPH × USDT farming and xALPH staking campaign targets live, straight from Alephium mainnet.</p>
      <div class="live-indicator"><span class="live-dot"></span>Auto-refresh <span id="next-refresh">in ${formatCountdown(REFRESH_INTERVAL_MS / 1000)}</span></div>
    </div>
  `
}

async function checkUnstake(rawAddress: string): Promise<void> {
  const address = rawAddress.trim()
  unstakeAddress = address
  unstakeResult = null
  unstakeError = null

  if (!address) {
    unstakeError = 'Enter an Alephium address.'
    render()
    return
  }
  if (!isAlephiumAddress(address)) {
    unstakeError = 'That does not look like a valid Alephium address.'
    render()
    return
  }
  saveRecentAddress(address)
  if (!data) {
    unstakeError = 'Live data not loaded yet — try again in a moment.'
    render()
    return
  }

  unstakeLoading = true
  render()
  try {
    const { fetchPendingUnstakes, fetchXalphLpPositions, fetchXalphToAlphSwapQuote } = await import('./xalphPositions.ts')
    const [balanceResult, pendingResult, lpResult] = await Promise.allSettled([
      fetchAddressXalphBalance(address),
      fetchPendingUnstakes(address),
      fetchXalphLpPositions(address),
    ])
    if (balanceResult.status === 'rejected') throw balanceResult.reason

    const xalphBalance = balanceResult.value
    const pendingUnstakes = pendingResult.status === 'fulfilled' ? pendingResult.value : []
    const lpPositions = lpResult.status === 'fulfilled' ? lpResult.value : []

    const lpXalph = lpPositions.reduce((s, p) => s + p.xalphAmount, 0)
    const pendingAlph = pendingUnstakes.reduce((s, p) => s + p.totalUnstakeAmount, 0)
    const totalXalph = xalphBalance + lpXalph

    // Real swap quote (fee + price impact included) rather than amount × spot price;
    // falls back to the spot-price estimate if the simulation fails for any reason.
    let swapQuote: Awaited<ReturnType<typeof fetchXalphToAlphSwapQuote>> = null
    try {
      swapQuote = await fetchXalphToAlphSwapQuote(totalXalph)
    } catch {
      swapQuote = null
    }

    // Scoped to just the xALPH-conversion methods (excludes the common +pendingAlph term,
    // which is identical either way and would otherwise dilute the comparison).
    const xalphAtRedemption = totalXalph * data.vault.redemptionRate
    const xalphAtMarket = swapQuote?.alphOut ?? totalXalph * xalphMarketRate(data)
    const deviationPct = xalphAtRedemption > 0 ? ((xalphAtMarket - xalphAtRedemption) / xalphAtRedemption) * 100 : 0

    const alphAtRedemption = xalphAtRedemption + pendingAlph
    const alphAtMarket = xalphAtMarket + pendingAlph
    // Every xALPH has ever been minted at 1:1 (redemption rate started at exactly 1.0 and only
    // rises) — so this is real accrued yield, not an estimate, for the convertible xALPH balance.
    const stakingYieldAlph = totalXalph * (data.vault.redemptionRate - 1)

    unstakeResult = {
      address,
      xalphBalance,
      lpPositions,
      pendingUnstakes,
      alphAtRedemption,
      alphAtMarket,
      deviationPct,
      stakingYieldAlph,
    }
  } catch (err) {
    unstakeError = err instanceof Error ? err.message : 'Failed to fetch xALPH balance for this address.'
  } finally {
    unstakeLoading = false
    render()
  }
}

async function load(): Promise<void> {
  loading = true
  render()
  try {
    const fresh = await fetchDashboardData()
    data = fresh
    errorMessage = null
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : 'unknown error'
  } finally {
    loading = false
    render()
  }
}

void load()
setInterval(() => void load(), REFRESH_INTERVAL_MS)
setInterval(tick, 1000)
