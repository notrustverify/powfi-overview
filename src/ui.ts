import { logoUrl, themeToggleButton } from './theme.ts'

export const GITHUB_REPO_URL = 'https://github.com/notrustverify/powfi-overview'

export function navigation(active: 'overview' | 'activity'): string {
  const base = import.meta.env.BASE_URL
  return `
    <header class="topbar">
      <a class="brand" href="${base}" aria-label="PowFi overview">
        <img class="logo-mark" src="${logoUrl()}" alt="" />
        <span>PowFi<span class="brand-caption">Community dashboard</span></span>
      </a>
      <nav class="main-nav" aria-label="Main navigation">
        <a class="nav-link ${active === 'overview' ? 'active' : ''}" ${active === 'overview' ? 'aria-current="page"' : ''} href="${base}">Overview</a>
        <a class="nav-link ${active === 'activity' ? 'active' : ''}" ${active === 'activity' ? 'aria-current="page"' : ''} href="${base}activity">Activity</a>
        <a class="nav-link" href="${base}#calculator">Calculator</a>
      </nav>
      <div class="topbar-actions">
        ${themeToggleButton()}
        <a class="launch-btn" href="https://powfi.alephium.org" target="_blank" rel="noopener">Open PowFi <span aria-hidden="true">↗</span></a>
      </div>
    </header>`
}
