export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

// undefined locale = the browser's own default (correct thousands/decimal separators,
// currency symbol placement, etc. for whoever's actually viewing the page).
export function formatCompact(n: number, digits = 2): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: digits }).format(n)
}

export function formatUsd(n: number, digits = 0): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    notation: n >= 10000 ? 'compact' : 'standard',
    maximumFractionDigits: digits,
  }).format(n)
}

export function formatNumber(n: number, digits = 2): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(n)
}

export function formatPercent(n: number, digits = 1): string {
  return `${formatNumber(n, digits)}%`
}

export function clampPct(n: number): number {
  return Math.max(0, Math.min(100, n))
}

export function shortAddress(addr: string, head = 6, tail = 6): string {
  if (addr.length <= head + tail + 3) return addr
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`
}

export function formatCountdown(totalSeconds: number): string {
  const seconds = Math.max(0, totalSeconds)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`
}

// A shared formatter so every call picks up the viewer's own locale (e.g. "il y a 5
// minutes" for a French browser) instead of hand-built, English-only strings.
const RTF = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

export function relativeTime(fromMs: number): string {
  const seconds = Math.round((Date.now() - fromMs) / 1000)
  if (seconds < 5) return RTF.format(0, 'second')
  if (seconds < 60) return RTF.format(-seconds, 'second')
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return RTF.format(-minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (hours < 24) return RTF.format(-hours, 'hour')
  const days = Math.round(hours / 24)
  if (days < 30) return RTF.format(-days, 'day')
  const months = Math.round(days / 30)
  if (months < 12) return RTF.format(-months, 'month')
  const years = Math.round(months / 12)
  return RTF.format(-years, 'year')
}

/** Like `relativeTime`, but for a timestamp that may be in the future (e.g. an unstake unlock date). */
export function formatRelativeToNow(targetMs: number): string {
  const diffMs = targetMs - Date.now()
  const abs = Math.abs(diffMs)
  const minutes = Math.round(abs / 60_000)
  const hours = Math.round(abs / 3_600_000)
  const days = Math.round(abs / 86_400_000)
  const sign = diffMs >= 0 ? 1 : -1
  if (minutes < 60) return RTF.format(sign * minutes, 'minute')
  if (hours < 48) return RTF.format(sign * hours, 'hour')
  return RTF.format(sign * days, 'day')
}

/** e.g. "Oct 24" — no year, for dates that are always within the current-ish range. */
export function formatMonthDay(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(ms)
}
