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
import { bindThemeToggle } from './theme.ts'
import { navigation } from './ui.ts'

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
const flippedStats = new Set<string>()

interface UnstakeResult {
  address: string
  xalphBalance: number
  lpPositions: LpPosition[]
  pendingUnstakes: PendingUnstake[]
  alphAtRedemption: number
  alphAtMarket: number
  deviationPct: number
  stakingYieldAlph: number
  swapQuoteSource: 'simulation' | 'spot' | 'none'
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

function progressCard(current: string, currentRaw: number, target: number, targetLabel: string, label: string, description: string, token: string, secondary: string): string {
  const pct = target > 0 ? (currentRaw / target) * 100 : 0
  const share = clampPct(pct)
  const formatChartAmount = (amount: number): string => token === '↔'
    ? formatUsd(amount)
    : `${formatCompact(token === '%' ? amount * data!.circulatingAlph / 100 : amount)} ALPH`
  const reachedLabel = token === '↔' ? 'Pool liquidity' : 'ALPH staked'
  const remainingLabel = token === '↔' ? 'Liquidity to target' : 'ALPH to target'
  const flipped = flippedStats.has(label)
  const chartSummary = `${formatPercent(pct, 1)} of the ${targetLabel} campaign target reached, ${formatChartAmount(Math.max(0, target - currentRaw))} remaining`
  return `
    <article class="card progress-card${flipped ? ' is-flipped' : ''}" id="stat-${label.toLowerCase().replaceAll(' ', '-')}" role="button" tabindex="0" data-stat="${label}" data-chart-summary="${chartSummary}" aria-pressed="${flipped}" aria-label="${label}: ${flipped ? `${chartSummary}. Show stats` : 'show campaign target pie chart'}" title="${flipped ? 'Click to flip back' : 'Click to flip'}">
      <div class="stat-face stat-front" aria-hidden="${flipped}">
      <div class="metric-heading"><span class="token-mark" aria-hidden="true">${token}</span><div><h3>${label}</h3><p>${description}</p></div></div>
      <div class="metric-value">${current}</div>
      <div class="metric-secondary">${secondary}</div>
      <div class="progress-label"><span>Campaign progress</span><strong>${formatPercent(pct, 1)}</strong></div>
      <div class="bar-track" role="progressbar" aria-label="${label} campaign target" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${clampPct(pct)}" aria-valuetext="${formatPercent(pct, 1)} of target"><div class="bar-fill" style="width:${clampPct(pct)}%"></div></div>
      <div class="foot"><span>Target <strong>${targetLabel}</strong></span><span class="target-status ${pct >= 100 ? 'complete' : ''}">${pct < 100 ? 'In progress' : 'Target reached'}</span></div>
      <span class="stat-flip-hint" aria-hidden="true">Click to flip <span>↻</span></span>
      </div>
      <div class="stat-face stat-back" aria-hidden="${!flipped}">
        <h3 class="pie-heading">${label}</h3>
        <svg class="stat-pie" viewBox="0 0 200 200" role="img" aria-label="${label}: ${chartSummary}.">
          <title>${label}: ${chartSummary}</title>
          <circle class="pie-track" cx="100" cy="100" r="80" />
          <circle class="pie-fill" cx="100" cy="100" r="80" pathLength="100" stroke-dasharray="${share} ${100 - share}" transform="rotate(-90 100 100)" />
          <text class="pie-percent" x="100" y="89">${formatPercent(pct, 1)}</text>
          <text class="pie-caption" x="100" y="115">${pct >= 100 ? 'Target reached' : 'of target reached'}</text>
          <text class="pie-target" x="100" y="134">${targetLabel}</text>
        </svg>
        <div class="pie-legend">
          <div><span><i class="pie-legend-reached" aria-hidden="true"></i>${reachedLabel}</span><strong>${formatChartAmount(currentRaw)}</strong></div>
          <div><span><i class="pie-legend-remaining" aria-hidden="true"></i>${remainingLabel}</span><strong>${formatChartAmount(Math.max(0, target - currentRaw))}</strong></div>
        </div>
        <span class="stat-flip-hint" aria-hidden="true">Click to flip back <span>↻</span></span>
      </div>
    </article>
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
  const lpXalph = r.lpPositions.reduce((s, p) => s + p.xalphAmount, 0)
  const pendingAlph = r.pendingUnstakes.reduce((s, p) => s + p.totalUnstakeAmount, 0)
  const pendingClaimableNow = r.pendingUnstakes.reduce((s, p) => s + p.claimableNow, 0)
  const hasXalph = r.xalphBalance + lpXalph > 0
  const differenceAlph = Math.abs(r.alphAtMarket - r.alphAtRedemption)
  const sameOutput = differenceAlph === 0
  const differenceAmount = differenceAlph < 0.000001 ? 'Less than 0.000001' : formatNumber(differenceAlph, 6)
  const higherMethod = r.alphAtMarket > r.alphAtRedemption ? 'swap' : 'redemption'
  const showHigher = hasXalph && !sameOutput
  const percentDifference = Math.abs(r.deviationPct) < 0.001 ? '<0.001%' : formatPercent(Math.abs(r.deviationPct), 3)
  const differenceLabel = !hasXalph
    ? 'No xALPH to compare'
    : sameOutput
      ? 'Both methods return the same amount'
      : `${differenceAmount} ALPH more from ${higherMethod === 'swap' ? 'swapping' : 'redemption'}`
  const differenceNote = !hasXalph
    ? 'Any pending unstakes are included equally in both totals.'
    : sameOutput
      ? 'Equal before network fees.'
      : `The swap ${r.swapQuoteSource === 'spot' ? 'estimate' : 'quote'} is ${percentDifference} ${higherMethod === 'swap' ? 'above' : 'below'} vault redemption for your xALPH.`
  const swapDescription = r.swapQuoteSource === 'simulation'
    ? 'Pool quote · trading fee and price impact included'
    : r.swapQuoteSource === 'spot'
      ? 'Spot estimate · trading fee and price impact excluded'
      : 'No xALPH available to swap'
  const stakingYieldUsdt = r.stakingYieldAlph * (data?.poolAlphUsdt.price.price1Per0 ?? 0)
  const yieldShareText = `I've earned ${formatNumber(r.stakingYieldAlph, 3)} $ALPH (~${formatNumber(stakingYieldUsdt, 2)} USDT) in staking yield with PowFi, @alephium's liquid staking platform.`
  const yieldShareUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(yieldShareText)}`

  return `
    <div class="unstake-result">
      <section class="yield-highlight" aria-labelledby="staking-yield-title">
        <div class="yield-heading"><span class="eyebrow">VAULT EARNINGS</span>${hasXalph ? `<a class="share-btn yield-share" href="${yieldShareUrl}" target="_blank" rel="noopener noreferrer" aria-label="Share your staking yield on X">Share on 𝕏 <span aria-hidden="true">↗</span></a>` : ''}</div>
        <h3 id="staking-yield-title">Staking yield earned so far</h3>
        <p class="yield-amount">${hasXalph ? `+${formatNumber(r.stakingYieldAlph, 3)} <span>ALPH</span>` : 'No xALPH balance found'}</p>
        <p class="yield-caption">${hasXalph ? `≈ ${formatNumber(stakingYieldUsdt, 2)} USDT · Yield reflected in the redemption rate of your idle and LP xALPH.` : 'An xALPH balance is needed to calculate earned yield.'}</p>
      </section>
      <div class="comparison-heading"><h3>Estimated ALPH you could receive</h3><span>${pendingAlph > 0 ? `Includes ${formatNumber(pendingAlph, 3)} ALPH in pending unstakes` : 'For your current xALPH position'}</span></div>
      <div class="unstake-comparison">
        <article class="comparison-card${showHigher && higherMethod === 'redemption' ? ' is-higher' : ''}" aria-labelledby="redemption-title">
          <div class="comparison-card-head"><span class="comparison-route" id="redemption-title">VIA VAULT REDEMPTION</span>${showHigher && higherMethod === 'redemption' ? '<span class="comparison-badge">Higher amount</span>' : ''}</div>
          <p class="comparison-amount">${formatNumber(r.alphAtRedemption, 3)} <span>ALPH</span></p>
          <p class="comparison-method">30-day linear claim</p>
        </article>
        <article class="comparison-card${showHigher && higherMethod === 'swap' ? ' is-higher' : ''}" aria-labelledby="swap-title">
          <div class="comparison-card-head"><span class="comparison-route" id="swap-title">VIA MARKET SWAP</span>${showHigher && higherMethod === 'swap' ? '<span class="comparison-badge">Higher amount</span>' : ''}</div>
          <p class="comparison-amount">${formatNumber(r.alphAtMarket, 3)} <span>ALPH</span></p>
          <p class="comparison-method">${swapDescription.replace('Pool quote · ', '').replace('Spot estimate · ', '')}</p>
        </article>
      </div>
      <div class="comparison-difference${showHigher ? ' has-difference' : ''}" role="status">
        <strong>${differenceLabel}</strong>
        <p>${escapeHtml(differenceNote)}</p>
      </div>
      <div class="position-breakdown">
      <h3>Position breakdown</h3>
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
      </div>
      <p class="adv-caveat">Totals include the xALPH side of any liquidity provided to the xALPH × ALPH pool (valued at the current pool price and tick range — the ALPH side of those positions isn't counted here) and any pending unstake requests already in the 30-day cooldown. Both would need to be withdrawn/claimed separately first.</p>
      <p class="adv-caveat">${r.swapQuoteSource === 'none' ? 'No xALPH conversion is included in these totals.' : r.swapQuoteSource === 'spot' ? 'The swap simulation was unavailable, so the swap amount uses the current spot rate without trading fees or price impact.' : 'The swap quote is an estimate and can change before you trade.'} Network fees are excluded from both methods. <a href="${POWFI_XALPH_TO_ALPH_SWAP_URL}" target="_blank" rel="noopener">Check the live swap quote ↗</a></p>
    </div>
  `
}

function unstakeSection(): string {
  const body = unstakeResult
    ? unstakeResultHtml(unstakeResult)
    : `<p class="calculator-hint">Compare vault redemption with a market swap, including your liquidity positions and pending unstakes.</p>`
  return `
    <section class="block" id="calculator">
      <div class="block-head">
        <div><span class="eyebrow">YOUR POSITION</span><h2>Unstake calculator <a class="anchor-link" href="#calculator" aria-label="Link to this section" title="Link to this section">#</a></h2></div>
        <span class="read-only-label">Read-only · No wallet connection</span>
      </div>
      <div class="card unstake-card">
        <label class="input-label" for="unstake-address">Alephium address</label>
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
              aria-describedby="calculator-help${unstakeError ? ' unstake-error' : ''}"
              aria-invalid="${Boolean(unstakeError)}"
            />
            <button type="button" class="addr-input-clear" id="unstake-address-clear" aria-label="Clear address" title="Clear">✕</button>
          </div>
          <button type="submit" class="refresh-btn primary-btn" ${unstakeLoading ? 'disabled' : ''}>${unstakeLoading ? 'Checking…' : 'Check position →'}</button>
        </form>
        <p class="input-help" id="calculator-help">Paste a public address to explore your xALPH position.</p>
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
        ${unstakeError ? `<p class="unstake-error" id="unstake-error" role="alert">${escapeHtml(unstakeError)}</p>` : ''}
        ${body}
      </div>
    </section>
  `
}

function stakedTweetUrl(alphStaked: number, circulatingPct: number, alphPriceUsdt: number): string {
  const usdtValue = formatCompact(alphStaked * alphPriceUsdt)
  const text = `${formatCompact(alphStaked)} $ALPH (~${usdtValue} $USDT) is now staked in @alephium's PowFi, ${formatPercent(circulatingPct, 2)} of circulating ALPH supply.`
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`
}

function render(): void {
  const focusedId = document.activeElement?.id
  const activeInput = document.activeElement instanceof HTMLInputElement ? document.activeElement : null
  const selection = activeInput ? [activeInput.selectionStart, activeInput.selectionEnd] as const : null
  const bannerHtml = errorMessage
    ? `<div class="banner" role="alert">Live data temporarily unavailable (${escapeHtml(errorMessage)}). ${data ? 'Showing last known values.' : 'Please try again.'}</div>`
    : ''

  if (!data) {
    app.innerHTML = `
      <div class="page">
        ${header()}
        ${bannerHtml}
        <div class="empty-state" role="status"><span class="eyebrow">${loading ? 'CONNECTING TO MAINNET' : 'CONNECTION INTERRUPTED'}</span><h2>${loading ? 'Fetching the latest numbers' : 'Unable to load live data'}</h2><p>${loading ? 'Reading staking and pool data from Alephium.' : 'Refresh to try connecting again.'}</p></div>
        ${loading ? '<div class="campaign-grid loading-grid" aria-hidden="true"><div class="card skeleton-card"></div><div class="card skeleton-card"></div><div class="card skeleton-card"></div></div>' : ''}
      </div>
    `
    bindThemeToggle(render)
    document.getElementById('refresh-btn')?.addEventListener('click', () => void load())
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
          <div><span class="eyebrow">ROUND 0</span><h2>Campaign progress</h2></div>
          <a class="share-btn" href="${stakedTweetUrl(d.vault.alphStaked, stakedPct, d.poolAlphUsdt.price.price1Per0)}" target="_blank" rel="noopener">Share on 𝕏</a>
        </div>
        <div class="campaign-grid">
          ${progressCard(`${formatCompact(d.vault.alphStaked)} <span class="value-unit">ALPH</span>`, d.vault.alphStaked, TARGETS.stakedAlph, `${formatCompact(TARGETS.stakedAlph)} ALPH`, 'Total staked', 'xALPH liquid staking', 'α', `≈ ${formatUsd(d.vault.alphStaked * d.poolAlphUsdt.price.price1Per0)} USD`)}
          ${progressCard(formatPercent(stakedPct, 2), stakedPct, TARGETS.stakingShareOfCirculatingPct, formatPercent(TARGETS.stakingShareOfCirculatingPct, 0), 'Staking participation', 'Share of circulating ALPH', '%', `Of ${formatCompact(d.circulatingAlph)} ALPH in circulation`)}
          ${progressCard(formatUsd(poolUsdtTvl), poolUsdtTvl, TARGETS.poolTvlUsd, formatUsd(TARGETS.poolTvlUsd), 'Farming liquidity', 'ALPH × USDT pool', '↔', 'Total value locked · USD')}
        </div>
        <p class="campaign-note"><span class="note-icon" aria-hidden="true">i</span> Staking and farming yields can be higher while their campaign targets remain unmet.</p>
      </section>

      <section class="market-strip" aria-label="Live market details">
        <div><span>Staking APR <small>7d average</small></span><strong class="positive">${formatPercent(d.vault.currentAprPct, 2)}</strong>${d.vault.aprIsPartial ? '<small>Partial 7-day window</small>' : ''}</div>
        <div><span>xALPH redemption rate</span><strong>${formatNumber(d.vault.redemptionRate, 6)} <small>ALPH</small></strong></div>
        <div><span>ALPH spot price</span><strong>${formatUsd(d.poolAlphUsdt.price.price1Per0, 4)}</strong></div>
        <a href="${import.meta.env.BASE_URL}activity.html">Explore staking activity <span aria-hidden="true">↗</span></a>
      </section>

      ${unstakeSection()}

      <details class="advanced" ${advancedOpen ? 'open' : ''}>
        <summary><span>Explore the details<small>Campaign parameters, reserves &amp; contracts</small></span><span class="chevron">⌄</span></summary>
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
          <span>ALPH ${formatUsd(d.poolAlphUsdt.price.price1Per0, 4)} · circulating supply ${formatCompact(d.circulatingAlph)} ALPH · data via node.mainnet.alephium.org &amp; api.powfi.alephium.org</span>
          <a href="${POWFI_URL}" target="_blank" rel="noopener">powfi.alephium.org ↗</a>
          <a href="${POWFI_FAQ_URL}" target="_blank" rel="noopener">FAQ ↗</a>
        </span>
      </footer>
    </div>
  `

  document.getElementById('refresh-btn')?.addEventListener('click', () => void load())
  document.querySelectorAll<HTMLElement>('.progress-card[data-stat]').forEach((card) => {
    const flip = (): void => {
      const label = card.dataset.stat!
      const flipped = card.classList.toggle('is-flipped')
      if (flipped) flippedStats.add(label)
      else flippedStats.delete(label)
      card.setAttribute('aria-pressed', String(flipped))
      card.setAttribute('aria-label', `${label}: ${flipped ? `${card.dataset.chartSummary}. Show stats` : 'show campaign target pie chart'}`)
      card.title = flipped ? 'Click to flip back' : 'Click to flip'
      card.querySelector('.stat-front')?.setAttribute('aria-hidden', String(flipped))
      card.querySelector('.stat-back')?.setAttribute('aria-hidden', String(!flipped))
    }
    card.addEventListener('click', flip)
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        flip()
      }
    })
  })
  document.querySelector('.advanced')?.addEventListener('toggle', (e) => {
    advancedOpen = (e.target as HTMLDetailsElement).open
  })
  document.getElementById('unstake-form')?.addEventListener('submit', (e) => {
    e.preventDefault()
    const input = document.getElementById('unstake-address') as HTMLInputElement | null
    void checkUnstake(input?.value ?? '')
  })
  document.getElementById('unstake-address')?.addEventListener('input', (e) => {
    unstakeAddress = (e.target as HTMLInputElement).value
  })
  document.querySelectorAll<HTMLButtonElement>('.recent-addr-btn').forEach((btn) => {
    btn.addEventListener('click', () => void checkUnstake(btn.dataset.address ?? ''))
  })
  document.getElementById('unstake-address-clear')?.addEventListener('click', () => {
    unstakeAddress = ''
    unstakeError = null
    unstakeResult = null
    render()
    document.getElementById('unstake-address')?.focus()
  })
  bindThemeToggle(render)
  if (focusedId) {
    const replacement = document.getElementById(focusedId)
    replacement?.focus({ preventScroll: true })
    if (replacement instanceof HTMLInputElement && selection) {
      replacement.setSelectionRange(selection[0], selection[1])
    }
  }
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
  nextRefreshEl.textContent = loading ? '…' : errorMessage ? '' : `in ${formatCountdown(Math.ceil(remainingMs / 1000))}`
}

function header(): string {
  return `
    ${navigation('overview')}
    <div class="hero">
      <div class="hero-copy"><span class="network-label"><span class="live-dot ${errorMessage ? 'is-stale' : ''}"></span>Alephium mainnet</span>
      <h1>PowFi <span class="accent">overview</span></h1>
      <p>Live staking, farming liquidity, and Round 0 campaign progress.</p></div>
      <div class="hero-status"><span class="round-label">CAMPAIGN <strong>ROUND 0</strong></span><div class="live-indicator">${errorMessage ? 'Data unavailable · retry' : loading ? 'Fetching live data…' : 'Auto-refresh'} <span id="next-refresh">${!loading && !errorMessage ? `in ${formatCountdown(REFRESH_INTERVAL_MS / 1000)}` : ''}</span></div><button class="refresh-btn" id="refresh-btn" ${loading ? 'disabled' : ''}>${loading ? 'Refreshing…' : '↻ Refresh data'}</button></div>
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
      swapQuoteSource: totalXalph <= 0 ? 'none' : swapQuote ? 'simulation' : 'spot',
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
