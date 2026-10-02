import './style.css'
import { fetchDashboardData } from './chain.ts'
import type { DashboardData } from './chain.ts'
import { escapeHtml } from './format.ts'
import { bindThemeToggle } from './theme.ts'
import { navigation, GITHUB_REPO_URL } from './ui.ts'
import { stakingSection, bindStaking, initializeStaking, connectedStakingAddress } from './staking.ts'

const app = document.querySelector<HTMLDivElement>('#app')!
let data: DashboardData | undefined
let loading = false
let error = ''

function render(): void {
  const focusedId = document.activeElement?.id
  const activeInput = document.activeElement instanceof HTMLInputElement ? document.activeElement : null
  const selection = activeInput ? [activeInput.selectionStart, activeInput.selectionEnd] as const : null
  app.innerHTML = `<div class="page">
    ${navigation('staking', connectedStakingAddress())}
    <main>
      <section class="hero"><div class="hero-copy"><span class="network-label"><span class="live-dot${error ? ' is-stale' : ''}"></span>Alephium mainnet</span><h1>Put your <span class="accent">ALPH to work.</span></h1><p>Stake with PowFi and earn yield while holding liquid xALPH.</p></div><button class="refresh-btn" id="staking-refresh" ${loading ? 'disabled' : ''}>${loading ? 'Refreshing…' : 'Refresh data'}</button></section>
      ${error ? `<div class="banner" role="alert">Unable to refresh live data. ${data ? 'Showing last known values.' : 'Please try again.'} ${escapeHtml(error)}</div>` : ''}
      ${data ? stakingSection(data) : `<div class="empty-state" role="status"><h2>${loading ? 'Loading staking data…' : 'Staking data unavailable'}</h2><p>${loading ? 'Reading the current yield and xALPH exchange rate.' : 'Use Refresh data to try again.'}</p></div>`}
    </main>
    <footer class="footer"><span>PowFi · Community dashboard</span><div class="footer-links"><a href="${GITHUB_REPO_URL}" target="_blank" rel="noopener noreferrer">GitHub ↗</a><a href="https://powfi.alephium.org" target="_blank" rel="noopener noreferrer">PowFi ↗</a></div></footer>
  </div>`
  bindThemeToggle(render)
  bindStaking()
  document.getElementById('staking-refresh')?.addEventListener('click', () => void load())
  if (focusedId) {
    const replacement = document.getElementById(focusedId)
    replacement?.focus({ preventScroll: true })
    if (replacement instanceof HTMLInputElement && selection) replacement.setSelectionRange(...selection)
  }
}

async function load(): Promise<void> {
  if (loading) return
  loading = true
  render()
  try {
    data = await fetchDashboardData()
    error = ''
  } catch (err) {
    error = err instanceof Error ? err.message : 'Connection failed.'
  } finally {
    loading = false
    render()
  }
}

initializeStaking(render, () => void load())
void load()
window.setInterval(() => void load(), 120_000)
