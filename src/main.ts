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

function statCard(value: string, label: string, sub?: string): string {
  return `
    <div class="card stat">
      <div>
        <div class="value">${value}</div>
        <div class="label">${label}${sub ? `<span class="sub">${sub}</span>` : ''}</div>
      </div>
    </div>
  `
}

function progressCard(valueLabel: string, current: number, target: number, targetLabel: string): string {
  const pct = target > 0 ? (current / target) * 100 : 0
  return `
    <div class="card progress-card">
      <div class="row">
        <span class="value">${valueLabel}</span>
        <span class="target">of ${targetLabel} target</span>
      </div>
      <div class="bar-track"><div class="bar-fill" style="width:${clampPct(pct)}%"></div></div>
      <div class="foot"><span>${formatPercent(pct, 1)} of target</span><span>${pct < 100 ? 'below target — bonus rate applies' : 'target reached'}</span></div>
    </div>
  `
}

function reserveList(pool: PoolData): string {
  const rows = [
    { sym: 'ALPH', amt: pool.alphReserve },
    ...pool.tokenReserves.map((r) => ({ sym: r.meta.symbol, amt: r.amount })),
  ]
  return `
    <div class="card full">
      <div class="reserve-list">
        ${rows
          .map(
            (r) => `<div class="reserve-row"><span class="sym">${r.sym} reserve</span><span class="amt">${formatNumber(r.amt, 4)}</span></div>`,
          )
          .join('')}
      </div>
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
          <h2>xALPH liquid staking</h2>
          <a class="addr-link" href="${explorerAddrUrl(XALPH_VAULT_ADDRESS)}" target="_blank" rel="noopener">${shortAddress(XALPH_VAULT_ADDRESS)}</a>
        </div>
        <div class="grid">
          ${progressCard(`${formatCompact(d.vault.alphStaked)} ALPH`, d.vault.alphStaked, TARGETS.stakedAlph, `${formatCompact(TARGETS.stakedAlph)} ALPH`)}
          ${statCard(`${formatPercent(TARGETS.stakingApyPct, 0)}`, 'Target APY', 'monthly re-evaluation')}
          ${statCard(`${formatPercent(stakedPct, 2)}`, 'of circulating ALPH staked', `target ${formatPercent(TARGETS.stakingShareOfCirculatingPct, 0)}`)}
          ${statCard(`1 xALPH ≈ ${formatNumber(d.vault.redemptionRate, 6)} ALPH`, 'Redemption rate', `${formatCompact(d.vault.xalphIssued)} xALPH issued`)}
        </div>
        <p class="note">*While staking sits below target, APY will be significantly higher.</p>
      </section>

      <section class="block">
        <div class="block-head">
          <h2>ALPH × USDT farming pool</h2>
          <a class="addr-link" href="${explorerAddrUrl(POOL_ALPH_USDT_ADDRESS)}" target="_blank" rel="noopener">${shortAddress(POOL_ALPH_USDT_ADDRESS)}</a>
        </div>
        <div class="grid">
          ${progressCard(formatUsd(poolUsdtTvl), poolUsdtTvl, TARGETS.poolTvlUsd, formatUsd(TARGETS.poolTvlUsd))}
          ${statCard(`${formatPercent(TARGETS.poolApyPct, 0)}`, 'Target APY', 'in-range liquidity only')}
          ${statCard(impliedAlphPrice !== null ? `$${formatNumber(impliedAlphPrice, 4)}` : '—', 'ALPH price implied by pool', `oracle: $${formatNumber(d.alphPriceUsd, 4)}`)}
          ${reserveList(d.poolAlphUsdt)}
        </div>
        <p class="note">*While TVL sits below target, early LPs can earn substantially higher APYs.</p>
      </section>

      <section class="block">
        <div class="block-head">
          <h2>xALPH × ALPH pool</h2>
          <a class="addr-link" href="${explorerAddrUrl(POOL_XALPH_ALPH_ADDRESS)}" target="_blank" rel="noopener">${shortAddress(POOL_XALPH_ALPH_ADDRESS)}</a>
        </div>
        <div class="grid">
          ${statCard(formatUsd(poolXalphTvl), 'Total value locked')}
          ${statCard(
            marketXalphRate !== null ? `1 xALPH ≈ ${formatNumber(marketXalphRate, 6)} ALPH` : '—',
            'Market price (pool)',
            pegDeviationPct !== null ? `${pegDeviationPct >= 0 ? '+' : ''}${formatPercent(pegDeviationPct, 3)} vs redemption rate` : undefined,
          )}
          ${reserveList(d.poolXalphAlph)}
        </div>
      </section>

      <footer>
        <span>ALPH ${formatUsd(d.alphPriceUsd, 4)} · circulating supply ${formatCompact(d.circulatingAlph)} ALPH · data via node.mainnet.alephium.org &amp; CoinGecko</span>
        <span style="display:flex;align-items:center;gap:10px">
          <span>Updated ${relativeTime(d.fetchedAt)}</span>
          <button class="refresh-btn" id="refresh-btn" ${loading ? 'disabled' : ''}>${loading ? 'Refreshing…' : 'Refresh'}</button>
        </span>
      </footer>
    </div>
  `

  document.getElementById('refresh-btn')?.addEventListener('click', () => void load())
}

function header(): string {
  return `
    <div class="topbar">
      <svg class="logo-mark" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M6 6 L14 16 L6 26 H10.5 L16 19.2 L21.5 26 H26 L18 16 L26 6 H21.5 L16 12.8 L10.5 6 Z" fill="currentColor"/>
      </svg>
      <span class="pill">Round 0</span>
    </div>
    <div class="hero">
      <span class="pill">Live · Alephium mainnet</span>
      <h1>PowFi <span class="accent">Round 0</span> dashboard.</h1>
      <p>Live on-chain stats for xALPH liquid staking and the ALPH farming campaign — reserves, TVL and staking targets, read straight from Alephium mainnet.</p>
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
