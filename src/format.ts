export function formatCompact(n: number, digits = 2): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: digits }).format(n)
}

export function formatUsd(n: number, digits = 0): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: n >= 10000 ? 'compact' : 'standard',
    maximumFractionDigits: digits,
  }).format(n)
}

export function formatNumber(n: number, digits = 2): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(n)
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

export function relativeTime(fromMs: number): string {
  const seconds = Math.round((Date.now() - fromMs) / 1000)
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.round(days / 30)
  if (months < 12) return `${months}mo ago`
  const years = Math.round(months / 12)
  return `${years}y ago`
}

/** Like `relativeTime`, but for a timestamp that may be in the future (e.g. an unstake unlock date). */
export function formatRelativeToNow(targetMs: number): string {
  const diffMs = targetMs - Date.now()
  const abs = Math.abs(diffMs)
  const minutes = Math.round(abs / 60_000)
  const hours = Math.round(abs / 3_600_000)
  const days = Math.round(abs / 86_400_000)
  const label = minutes < 60 ? `${minutes}m` : hours < 48 ? `${hours}h` : `${days}d`
  return diffMs >= 0 ? `in ${label}` : `${label} ago`
}

/** e.g. "Oct 24" — no year, for dates that are always within the current-ish range. */
export function formatMonthDay(ms: number): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(ms)
}
