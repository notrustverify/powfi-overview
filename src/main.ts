import './style.css'
import {
  fetchDashboardData,
  poolTvlUsd,
  TARGETS,
  XALPH_VAULT_ADDRESS,
  POOL_ALPH_USDT_ADDRESS,
  POOL_XALPH_ALPH_ADDRESS,
  EXPLORER_APP_URL,
} from './chain.ts'
import type { DashboardData, PoolData } from './chain.ts'
import { formatCompact, formatUsd, formatNumber, formatPercent, formatCountdown, clampPct, shortAddress, relativeTime } from './format.ts'

const REFRESH_INTERVAL_MS = 120_000
const POWFI_URL = 'https://powfi.alephium.org'
const POWFI_FAQ_URL = 'https://docs.alephium.org/powfi/faq'

const app = document.querySelector<HTMLDivElement>('#app')!

let data: DashboardData | null = null
let errorMessage: string | null = null
let loading = true
let advancedOpen = false

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

function reserveRatioEstimate(pegDeviationPct: number | null): string {
  if (pegDeviationPct === null) return '—'
  const sign = pegDeviationPct >= 0 ? '+' : ''
  return `${sign}${formatNumber(pegDeviationPct, 2)}%`
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
  const poolUsdtTvl = poolTvlUsd(d.poolAlphUsdt, d.alphPriceUsd, d.vault.redemptionRate)
  const poolXalphTvl = poolTvlUsd(d.poolXalphAlph, d.alphPriceUsd, d.vault.redemptionRate)

  const xalphAlphReserve = d.poolXalphAlph.tokenReserves.find((r) => r.meta.symbol === 'XALPH')
  const marketXalphRate = xalphAlphReserve && xalphAlphReserve.amount > 0 ? d.poolXalphAlph.alphReserve / xalphAlphReserve.amount : null
  const pegDeviationPct = marketXalphRate !== null ? ((marketXalphRate - d.vault.redemptionRate) / d.vault.redemptionRate) * 100 : null

  const impliedAlphUsdt = d.poolAlphUsdt.tokenReserves.find((r) => r.meta.symbol === 'USDT')
  const impliedAlphPrice = impliedAlphUsdt && d.poolAlphUsdt.alphReserve > 0 ? impliedAlphUsdt.amount / d.poolAlphUsdt.alphReserve : null

  app.innerHTML = `
    <div class="page">
      ${header()}
      ${bannerHtml}

      <section class="block">
        <div class="block-head">
          <h2>Campaign targets: overview.</h2>
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
            <div class="reserve-row"><span class="sym">ALPH staked (exact)</span><span class="amt">${formatNumber(d.vault.alphStaked, 4)}</span></div>
            <div class="reserve-row"><span class="sym">xALPH issued</span><span class="amt">${formatNumber(d.vault.xalphIssued, 4)}</span></div>
            <div class="reserve-row"><span class="sym">Redemption rate</span><span class="amt">${formatNumber(d.vault.redemptionRate, 8)} ALPH / xALPH</span></div>
          </div>
          <div class="adv-group">
            <h3>ALPH × USDT pool</h3>
            ${reserveList(d.poolAlphUsdt)}
            <div class="reserve-row"><span class="sym">ALPH price implied by pool</span><span class="amt">${impliedAlphPrice !== null ? `$${formatNumber(impliedAlphPrice, 4)}` : '—'}</span></div>
            <div class="reserve-row"><span class="sym">Oracle price (CoinGecko)</span><span class="amt">$${formatNumber(d.alphPriceUsd, 4)}</span></div>
          </div>
          <div class="adv-group">
            <h3>xALPH × ALPH pool</h3>
            ${reserveList(d.poolXalphAlph)}
            <div class="reserve-row"><span class="sym">Pool TVL</span><span class="amt">${formatUsd(poolXalphTvl)}</span></div>
            <div class="reserve-row"><span class="sym">Reserve-ratio price (est.)</span><span class="amt">${marketXalphRate !== null ? `1 xALPH ≈ ${formatNumber(marketXalphRate, 6)} ALPH` : '—'}</span></div>
            <div class="reserve-row"><span class="sym">vs. redemption rate</span><span class="amt">${reserveRatioEstimate(pegDeviationPct)}</span></div>
            <p class="adv-caveat">Estimated from total pool reserves, not a live swap quote — for concentrated-liquidity pools this can diverge a lot from the price you'd actually get. Check the swap page on <a href="${POWFI_URL}" target="_blank" rel="noopener">powfi.alephium.org</a> for real pricing.</p>
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
  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    setTheme(getTheme() === 'dark' ? 'light' : 'dark')
    render()
  })
  tick()
}

function tick(): void {
  const lastUpdatedEl = document.getElementById('last-updated')
  const nextRefreshEl = document.getElementById('next-refresh')
  if (!data || !lastUpdatedEl || !nextRefreshEl) return

  lastUpdatedEl.textContent = `Updated ${relativeTime(data.fetchedAt)}`

  const remainingMs = data.fetchedAt + REFRESH_INTERVAL_MS - Date.now()
  nextRefreshEl.textContent = loading ? '…' : `in ${formatCountdown(Math.ceil(remainingMs / 1000))}`
}

type Theme = 'light' | 'dark'

function getTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  try {
    localStorage.setItem('powfi-theme', theme)
  } catch {
    // localStorage unavailable (private mode etc.) — theme just won't persist.
  }
}

const SUN_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`
const MOON_ICON = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 1020.354 15.354Z"/></svg>`

function header(): string {
  const theme = getTheme()
  const logoUrl = `${import.meta.env.BASE_URL}${theme === 'dark' ? 'alephium-logo-white.svg' : 'alephium-logo-black.svg'}`
  return `
    <div class="topbar">
      <a href="${POWFI_URL}" target="_blank" rel="noopener" title="powfi.alephium.org"><img class="logo-mark" src="${logoUrl}" alt="Alephium" /></a>
      <div style="display:flex;align-items:center;gap:10px">
        <button class="theme-toggle" id="theme-toggle" aria-label="Switch to ${theme === 'dark' ? 'light' : 'dark'} theme" title="Switch to ${theme === 'dark' ? 'light' : 'dark'} theme">${theme === 'dark' ? SUN_ICON : MOON_ICON}</button>
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
