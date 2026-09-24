import './style.css'
import { fetchStakingHistory, MAX_ACTIVITY_EVENTS, EXPLORER_APP_URL, XALPH_VAULT_ADDRESS } from './chain.ts'
import type { StakingActivityEntry, StakingActivityKind, StakePoint } from './chain.ts'
import { formatNumber, shortAddress, relativeTime, formatRelativeToNow, formatMonthDay } from './format.ts'
import { themeToggleButton, bindThemeToggle, logoUrl } from './theme.ts'
import { stakeChartHtml, bindStakeChart } from './stakeChart.ts'

const REVEAL_BATCH = 50 // how many more rows to render per scroll trigger — a UI reveal, not a network page
// Hidden for now: distributeRewards() has never fired on-chain (rewardRate is 0), so this
// kind never actually appears — easy to bring back once rewards start flowing.
const HIDDEN_KINDS: StakingActivityKind[] = ['rewardDeposited']
const POWFI_URL = 'https://powfi.alephium.org'

// Sep 14–21 is a handful of one-off seed/whale stakes that dwarf day-to-day
// activity and flatten the interesting part of the curve — crop the chart to
// the clearer recent window, carrying the pre-cutoff total forward as the start.
const CHART_START_MS = Date.parse('2026-09-22T00:00:00Z')

function clampTimelineStart(points: StakePoint[], startAt: number): StakePoint[] {
  const before = points.filter((p) => p.timestamp < startAt)
  const after = points.filter((p) => p.timestamp >= startAt)
  const carried = before.length > 0 ? before[before.length - 1].totalStaked : 0
  return [{ timestamp: startAt, totalStaked: carried }, ...after]
}

const app = document.querySelector<HTMLDivElement>('#app')!

// One fetch (fetchStakingHistory) serves both the list and the chart below — no
// point re-requesting the same event log twice.
let allEntries: StakingActivityEntry[] = []
let timeline: StakePoint[] = []
let loading = true
let errorMessage: string | null = null
let activeFilter: StakingActivityKind | 'all' = 'all'
let visibleCount = REVEAL_BATCH
let sentinelObserver: IntersectionObserver | null = null

function explorerAddrUrl(addr: string): string {
  return `${EXPLORER_APP_URL}/addresses/${addr}`
}

function explorerTxUrl(txHash: string): string {
  return `${EXPLORER_APP_URL}/transactions/${txHash}`
}

const KIND_LABEL: Record<StakingActivityKind, string> = {
  stake: 'Staked',
  unstakeScheduled: 'Unstake started',
  unstakeCancelled: 'Unstake cancelled',
  rewardDeposited: 'Reward deposited',
}

const KIND_CLASS: Record<StakingActivityKind, string> = {
  stake: 'kind-stake',
  unstakeScheduled: 'kind-unstake',
  unstakeCancelled: 'kind-cancelled',
  rewardDeposited: 'kind-reward',
}

const FILTER_OPTIONS: { value: StakingActivityKind | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'stake', label: 'Staked' },
  { value: 'unstakeScheduled', label: 'Unstake started' },
  { value: 'unstakeCancelled', label: 'Unstake cancelled' },
]

function claimableCell(e: StakingActivityEntry): string {
  if (e.kind !== 'unstakeScheduled' || e.claimableAt == null) return '<span class="activity-claim"></span>'
  const isReady = e.claimableAt <= Date.now()
  const label = isReady ? 'Claimable now' : `Claimable ${formatRelativeToNow(e.claimableAt)}`
  return `
    <span class="activity-claim${isReady ? ' claim-ready' : ''}" title="Claimable on ${formatMonthDay(e.claimableAt)}">
      ${label}
      <small class="activity-claim-date">${formatMonthDay(e.claimableAt)}</small>
    </span>
  `
}

function activityRow(e: StakingActivityEntry): string {
  const amountLabel =
    e.kind === 'rewardDeposited'
      ? `${formatNumber(e.alphAmount, 4)} ALPH`
      : `${formatNumber(e.alphAmount, 4)} ALPH ↔ ${formatNumber(e.xalphAmount, 4)} xALPH`
  return `
    <a class="activity-row" href="${explorerTxUrl(e.txHash)}" target="_blank" rel="noopener">
      <span class="kind-badge ${KIND_CLASS[e.kind]}">${KIND_LABEL[e.kind]}</span>
      <span class="activity-addr">${shortAddress(e.address)}</span>
      <span class="activity-amt">${amountLabel}</span>
      ${claimableCell(e)}
      <span class="activity-time">${relativeTime(e.timestamp)}</span>
    </a>
  `
}

function filterBar(): string {
  return `
    <div class="filter-bar">
      ${FILTER_OPTIONS.map(
        (o) => `<button class="filter-btn${activeFilter === o.value ? ' active' : ''}" data-filter="${o.value}">${o.label}</button>`,
      ).join('')}
    </div>
  `
}

function render(): void {
  const bannerHtml = errorMessage
    ? `<div class="banner">Live data temporarily unavailable (${errorMessage}). ${allEntries.length > 0 ? 'Showing what loaded before the error.' : ''}</div>`
    : ''

  const filtered = allEntries.filter((e) => activeFilter === 'all' || e.kind === activeFilter)
  const visible = filtered.slice(0, visibleCount)
  const hasMoreToShow = visibleCount < filtered.length
  const chartPoints = loading ? null : clampTimelineStart(timeline, CHART_START_MS)

  const listOrEmpty =
    visible.length === 0
      ? loading
        ? `<p class="skeleton" style="text-align:center">Loading on-chain activity…</p>`
        : `<p class="skeleton" style="text-align:center">${allEntries.length === 0 ? 'No staking activity found.' : 'No events match this filter.'}</p>`
      : `<div class="activity-list">${visible.map(activityRow).join('')}</div>`

  const footerLine = !hasMoreToShow
    ? visible.length > 0
      ? `<p class="activity-end">That's the full history.</p>`
      : ''
    : `<div id="load-more-sentinel" class="activity-sentinel"></div>`

  app.innerHTML = `
    <div class="page">
      <div class="topbar">
        <a href="${POWFI_URL}" target="_blank" rel="noopener" title="powfi.alephium.org"><img class="logo-mark" src="${logoUrl()}" alt="Alephium" /></a>
        <div style="display:flex;align-items:center;gap:10px">
          <a class="nav-link" href="${import.meta.env.BASE_URL}">Dashboard</a>
          ${themeToggleButton()}
          <span class="pill">Round 0</span>
        </div>
      </div>

      <div class="hero">
        <span class="pill">Live · Alephium mainnet</span>
        <h1>xALPH staking <span class="accent">activity</span>.</h1>
        <p>Every stake, unstake, and cancellation event read straight from the
          <a class="addr-link" href="${explorerAddrUrl(XALPH_VAULT_ADDRESS)}" target="_blank" rel="noopener">xALPH vault's</a>
          on-chain event log (up to ${formatNumber(MAX_ACTIVITY_EVENTS, 0)}) — no private API involved, loaded once and revealed as you scroll.
          Unstakes show when the ALPH becomes claimable, 30 days after the request.</p>
      </div>

      ${bannerHtml}

      <section class="block">
        <div class="block-head">
          <h2>Total ALPH staked over time.</h2>
        </div>
        ${stakeChartHtml(chartPoints, loading, errorMessage)}
        <p class="note" style="margin-top:14px">Reconstructed from the same events as the list below, since ${formatMonthDay(CHART_START_MS)} — not a smoothed estimate. Earlier one-off seed stakes are folded into the starting value.</p>
      </section>

      <section class="block">
        <div class="block-head">
          <h2>Recent activity${allEntries.length > 0 ? ` <span class="block-head-count">(${formatNumber(allEntries.length, 0)} loaded)</span>` : ''}.</h2>
          <button class="refresh-btn" id="refresh-btn" ${loading ? 'disabled' : ''}>${loading ? 'Loading…' : 'Refresh'}</button>
        </div>
        ${filterBar()}
        ${listOrEmpty}
        ${footerLine}
      </section>

      <footer>
        <span>Data via node.mainnet.alephium.org &amp; backend.mainnet.alephium.org</span>
        <a href="${POWFI_URL}" target="_blank" rel="noopener">powfi.alephium.org ↗</a>
      </footer>
    </div>
  `

  document.getElementById('refresh-btn')?.addEventListener('click', () => void load())
  document.querySelectorAll<HTMLButtonElement>('.filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeFilter = btn.dataset.filter as StakingActivityKind | 'all'
      visibleCount = REVEAL_BATCH
      render()
    })
  })
  bindThemeToggle(render)
  bindSentinel()
  bindStakeChart(chartPoints)
}

function bindSentinel(): void {
  sentinelObserver?.disconnect()
  const sentinel = document.getElementById('load-more-sentinel')
  if (!sentinel) return
  sentinelObserver = new IntersectionObserver((observed) => {
    if (observed[0]?.isIntersecting) {
      visibleCount += REVEAL_BATCH
      render()
    }
  })
  sentinelObserver.observe(sentinel)
}

async function load(): Promise<void> {
  loading = true
  render()
  try {
    const history = await fetchStakingHistory()
    allEntries = history.entries.filter((e) => !HIDDEN_KINDS.includes(e.kind))
    timeline = history.timeline
    errorMessage = null
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : 'unknown error'
  } finally {
    loading = false
    visibleCount = REVEAL_BATCH
    render()
  }
}

void load()
