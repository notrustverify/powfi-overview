import './style.css'
import { fetchStakingActivityPage, MAX_ACTIVITY_EVENTS, EXPLORER_APP_URL, XALPH_VAULT_ADDRESS } from './chain.ts'
import type { StakingActivityEntry, StakingActivityKind } from './chain.ts'
import { formatNumber, shortAddress, relativeTime, formatRelativeToNow, formatMonthDay } from './format.ts'
import { themeToggleButton, bindThemeToggle, logoUrl } from './theme.ts'

const PAGE_SIZE = 50
// Hidden for now: distributeRewards() has never fired on-chain (rewardRate is 0), so this
// kind never actually appears — easy to bring back once rewards start flowing.
const HIDDEN_KINDS: StakingActivityKind[] = ['rewardDeposited']
const POWFI_URL = 'https://powfi.alephium.org'

const app = document.querySelector<HTMLDivElement>('#app')!

let entries: StakingActivityEntry[] = []
let nextPage = 1
let hasMore = true
let isFetching = false // covers both the first load and subsequent page loads; set by loadMore() itself
let errorMessage: string | null = null
let activeFilter: StakingActivityKind | 'all' = 'all'
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
    ? `<div class="banner">Live data temporarily unavailable (${errorMessage}). ${entries.length > 0 ? 'Showing what loaded so far.' : ''}</div>`
    : ''

  const filtered = entries.filter((e) => activeFilter === 'all' || e.kind === activeFilter)

  const listOrEmpty =
    filtered.length === 0
      ? isFetching
        ? `<p class="skeleton" style="text-align:center">Loading on-chain activity…</p>`
        : `<p class="skeleton" style="text-align:center">${entries.length === 0 ? 'No staking activity found.' : 'No events match this filter.'}</p>`
      : `<div class="activity-list">${filtered.map(activityRow).join('')}</div>`

  const footerLine = !hasMore
    ? entries.length > 0
      ? `<p class="activity-end">That's the full history.</p>`
      : ''
    : `<div id="load-more-sentinel" class="activity-sentinel">${isFetching ? 'Loading more…' : ''}</div>`

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
        <p>Stake and unstake events read straight from the
          <a class="addr-link" href="${explorerAddrUrl(XALPH_VAULT_ADDRESS)}" target="_blank" rel="noopener">xALPH vault's</a>
          on-chain event log — no private API involved. Scroll to load more (up to ${formatNumber(MAX_ACTIVITY_EVENTS, 0)}).
          Unstakes show when the ALPH becomes claimable, 30 days after the request.</p>
      </div>

      ${bannerHtml}

      <section class="block">
        <div class="block-head">
          <h2>Recent activity${entries.length > 0 ? ` <span class="block-head-count">(${formatNumber(entries.length, 0)} loaded)</span>` : ''}.</h2>
          <button class="refresh-btn" id="refresh-btn" ${isFetching ? 'disabled' : ''}>${isFetching ? 'Loading…' : 'Refresh'}</button>
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

  document.getElementById('refresh-btn')?.addEventListener('click', () => void reload())
  document.querySelectorAll<HTMLButtonElement>('.filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeFilter = btn.dataset.filter as StakingActivityKind | 'all'
      render()
      bindSentinel()
    })
  })
  bindThemeToggle(render)
  bindSentinel()
}

function bindSentinel(): void {
  sentinelObserver?.disconnect()
  const sentinel = document.getElementById('load-more-sentinel')
  if (!sentinel) return
  sentinelObserver = new IntersectionObserver((observed) => {
    if (observed[0]?.isIntersecting) void loadMore()
  })
  sentinelObserver.observe(sentinel)
}

async function loadMore(): Promise<void> {
  if (isFetching || !hasMore || entries.length >= MAX_ACTIVITY_EVENTS) return
  isFetching = true
  render()
  try {
    const page = await fetchStakingActivityPage(nextPage, PAGE_SIZE)
    const visible = page.entries.filter((e) => !HIDDEN_KINDS.includes(e.kind))
    entries = entries.concat(visible)
    nextPage += 1
    hasMore = page.hasMore && entries.length < MAX_ACTIVITY_EVENTS
    errorMessage = null
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : 'unknown error'
    hasMore = false // stop auto-retrying; the Refresh button starts over
  } finally {
    isFetching = false
    render()
  }
}

async function reload(): Promise<void> {
  entries = []
  nextPage = 1
  hasMore = true
  await loadMore()
}

void loadMore()
