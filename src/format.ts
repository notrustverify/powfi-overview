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
  return `${hours}h ago`
}
