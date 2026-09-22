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
import { formatCompact, formatUsd, formatNumber, formatPercent, clampPct, shortAddress, relativeTime } from './format.ts'

const REFRESH_INTERVAL_MS = 60_000

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
            <div class="reserve-row"><span class="sym">Market price</span><span class="amt">${marketXalphRate !== null ? `1 xALPH ≈ ${formatNumber(marketXalphRate, 6)} ALPH` : '—'}</span></div>
            <div class="reserve-row"><span class="sym">Peg deviation vs redemption rate</span><span class="amt">${pegDeviationPct !== null ? `${pegDeviationPct >= 0 ? '+' : ''}${formatPercent(pegDeviationPct, 3)}` : '—'}</span></div>
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
        <span style="display:flex;align-items:center;gap:10px">
          <span>ALPH ${formatUsd(d.alphPriceUsd, 4)} · circulating supply ${formatCompact(d.circulatingAlph)} ALPH · data via node.mainnet.alephium.org &amp; CoinGecko</span>
          <button class="refresh-btn" id="refresh-btn" ${loading ? 'disabled' : ''}>${loading ? 'Refreshing…' : 'Refresh'}</button>
        </span>
      </footer>
    </div>
  `

  document.getElementById('refresh-btn')?.addEventListener('click', () => void load())
  document.querySelector('.advanced')?.addEventListener('toggle', (e) => {
    advancedOpen = (e.target as HTMLDetailsElement).open
  })
  tick()
}

function tick(): void {
  const lastUpdatedEl = document.getElementById('last-updated')
  const nextRefreshEl = document.getElementById('next-refresh')
  if (!data || !lastUpdatedEl || !nextRefreshEl) return

  lastUpdatedEl.textContent = `Updated ${relativeTime(data.fetchedAt)}`

  const remainingMs = data.fetchedAt + REFRESH_INTERVAL_MS - Date.now()
  nextRefreshEl.textContent = loading ? '…' : `in ${Math.max(0, Math.ceil(remainingMs / 1000))}s`
}

function header(): string {
  const logoUrl = `${import.meta.env.BASE_URL}alephium-logo.svg`
  return `
    <div class="topbar">
      <img class="logo-mark" src="${logoUrl}" alt="Alephium" />
      <span class="pill">Round 0</span>
    </div>
    <div class="hero">
      <span class="pill">Live · Alephium mainnet</span>
      <h1>PowFi <span class="accent">Round 0</span> goals.</h1>
      <p>Tracking the ALPH × USDT farming and xALPH staking campaign targets live, straight from Alephium mainnet.</p>
      <div class="live-indicator"><span class="live-dot"></span>Auto-refresh <span id="next-refresh">in ${REFRESH_INTERVAL_MS / 1000}s</span></div>
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
