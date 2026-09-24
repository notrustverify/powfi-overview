import type { StakePoint } from './chain.ts'
import { formatCompact, formatNumber, formatMonthDay } from './format.ts'

// Fixed height only — width is measured from the real container at draw time so
// 1 SVG unit == 1 CSS pixel in both axes. A viewBox scaled down to fit a narrow
// phone width would shrink the axis text along with the geometry, to the point
// of being unreadable; measuring avoids that instead of just guessing a size.
const H = 280
const MARGIN = { top: 16, right: 16, bottom: 28, left: 56 }

interface PlottedPoint extends StakePoint {
  x: number
  y: number
}

/** Rounds up to a "nice" axis ceiling (1/2/5 × a power of ten). */
function niceCeil(value: number): number {
  if (value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const steps = [1, 2, 5, 10]
  for (const step of steps) {
    const candidate = step * magnitude
    if (candidate >= value) return candidate
  }
  return 10 * magnitude
}

function buildGeometry(points: StakePoint[], w: number) {
  const plotW = w - MARGIN.left - MARGIN.right
  const plotH = H - MARGIN.top - MARGIN.bottom

  const firstTs = points[0].timestamp
  const lastTs = Math.max(Date.now(), points[points.length - 1].timestamp)
  const span = Math.max(lastTs - firstTs, 1)
  const leadIn = Math.max(span * 0.03, 60 * 60 * 1000)
  const tMin = firstTs - leadIn

  const finalTotal = points[points.length - 1].totalStaked
  const extended: StakePoint[] = [
    { timestamp: tMin, totalStaked: 0 },
    ...points,
    { timestamp: lastTs, totalStaked: finalTotal },
  ]

  const yMax = niceCeil(Math.max(finalTotal, 1) * 1.12)
  const xScale = (ts: number) => MARGIN.left + ((ts - tMin) / (lastTs - tMin)) * plotW
  const yScale = (v: number) => MARGIN.top + plotH - (v / yMax) * plotH

  const plotted: PlottedPoint[] = extended.map((p) => ({ ...p, x: xScale(p.timestamp), y: yScale(p.totalStaked) }))
  return { plotted, plotW, plotH, yMax, tMin, lastTs }
}

function stepPath(plotted: PlottedPoint[]): string {
  let d = `M ${plotted[0].x} ${plotted[0].y}`
  for (let i = 1; i < plotted.length; i++) {
    d += ` H ${plotted[i].x} V ${plotted[i].y}`
  }
  return d
}

/** Finds the point in effect at a given timestamp (the last one at or before it) — matches the step chart's own logic. */
function pointAt(plotted: PlottedPoint[], ts: number): PlottedPoint {
  let lo = 0
  let hi = plotted.length - 1
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (plotted[mid].timestamp <= ts) lo = mid
    else hi = mid - 1
  }
  return plotted[lo]
}

function buildSvgMarkup(points: StakePoint[], w: number): string {
  const { plotted, plotW, plotH, yMax } = buildGeometry(points, w)
  const linePath = stepPath(plotted)
  const areaPath = `${linePath} L ${plotted[plotted.length - 1].x} ${MARGIN.top + plotH} L ${plotted[0].x} ${MARGIN.top + plotH} Z`

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    value: yMax * f,
    y: MARGIN.top + plotH - f * plotH,
  }))

  const first = plotted[1] ?? plotted[0] // skip the synthetic zero lead-in for the x-axis start label
  const last = plotted[plotted.length - 1]
  const midTs = (first.timestamp + last.timestamp) / 2 // by time, not array index — events cluster unevenly
  const endLabelY = Math.max(plotted[plotted.length - 1].y, MARGIN.top + 10)

  return `
    <svg class="chart-svg" width="${w}" height="${H}" viewBox="0 0 ${w} ${H}" role="img" aria-label="Cumulative ALPH staked over time">
      ${yTicks
        .map(
          (t) => `
            <line class="chart-grid" x1="${MARGIN.left}" x2="${w - MARGIN.right}" y1="${t.y}" y2="${t.y}" />
            <text class="chart-axis-label" x="${MARGIN.left - 8}" y="${t.y}" text-anchor="end" dominant-baseline="middle">${formatCompact(t.value)}</text>
          `,
        )
        .join('')}
      <text class="chart-axis-label" x="${first.x}" y="${H - 8}" text-anchor="start">${formatMonthDay(first.timestamp)}</text>
      <text class="chart-axis-label" x="${(first.x + last.x) / 2}" y="${H - 8}" text-anchor="middle">${formatMonthDay(midTs)}</text>
      <text class="chart-axis-label" x="${last.x}" y="${H - 8}" text-anchor="end">${formatMonthDay(last.timestamp)}</text>

      <path class="chart-area" d="${areaPath}" />
      <path class="chart-line" d="${linePath}" />

      <text class="chart-end-label" x="${last.x - 6}" y="${endLabelY - 10}" text-anchor="end">${formatCompact(points[points.length - 1].totalStaked)} ALPH</text>

      <line class="chart-crosshair" x1="0" x2="0" y1="${MARGIN.top}" y2="${MARGIN.top + plotH}" style="opacity:0" />
      <circle class="chart-dot" r="4" style="opacity:0" />
      <rect class="chart-hit-area" x="${MARGIN.left}" y="${MARGIN.top}" width="${plotW}" height="${plotH}" fill="transparent" />
    </svg>
  `
}

export function stakeChartHtml(points: StakePoint[] | null, loading: boolean, error: string | null): string {
  if (error) {
    return `<div class="card chart-card"><p class="skeleton" style="text-align:center">Chart unavailable (${error}).</p></div>`
  }
  if (loading || !points) {
    return `<div class="card chart-card"><p class="skeleton" style="text-align:center">Building stake timeline from on-chain events…</p></div>`
  }
  if (points.length === 0) {
    return `<div class="card chart-card"><p class="skeleton" style="text-align:center">No stake events found yet.</p></div>`
  }
  return `
    <div class="card chart-card">
      <div class="chart-mount"></div>
      <div class="chart-tooltip" style="opacity:0"></div>
    </div>
  `
}

export function bindStakeChart(points: StakePoint[] | null): void {
  if (!points || points.length === 0) return
  const card = document.querySelector<HTMLDivElement>('.chart-card')
  const mount = card?.querySelector<HTMLDivElement>('.chart-mount')
  const tooltip = card?.querySelector<HTMLDivElement>('.chart-tooltip')
  if (!mount || !tooltip) return

  let lastWidth = 0

  function draw(): void {
    const width = Math.round(mount!.clientWidth)
    if (width <= 0 || Math.abs(width - lastWidth) < 4) return
    lastWidth = width
    mount!.innerHTML = buildSvgMarkup(points!, width)
    wireInteraction(width)
  }

  function wireInteraction(width: number): void {
    const svg = mount!.querySelector<SVGSVGElement>('.chart-svg')
    const hitArea = mount!.querySelector<SVGRectElement>('.chart-hit-area')
    const crosshair = mount!.querySelector<SVGLineElement>('.chart-crosshair')
    const dot = mount!.querySelector<SVGCircleElement>('.chart-dot')
    if (!svg || !hitArea || !crosshair || !dot) return

    const { plotted, tMin, lastTs, plotW } = buildGeometry(points!, width)

    function handleMove(clientX: number): void {
      const rect = svg!.getBoundingClientRect()
      const svgX = ((clientX - rect.left) / rect.width) * width
      if (svgX < MARGIN.left || svgX > width - MARGIN.right) {
        hide()
        return
      }
      const ts = tMin + ((svgX - MARGIN.left) / plotW) * (lastTs - tMin)
      const p = pointAt(plotted, ts)

      crosshair!.setAttribute('x1', String(p.x))
      crosshair!.setAttribute('x2', String(p.x))
      crosshair!.setAttribute('style', 'opacity:1')
      dot!.setAttribute('cx', String(p.x))
      dot!.setAttribute('cy', String(p.y))
      dot!.setAttribute('style', 'opacity:1')

      tooltip!.style.opacity = '1'
      tooltip!.textContent = ''
      const dateEl = document.createElement('div')
      dateEl.className = 'chart-tooltip-date'
      dateEl.textContent = formatMonthDay(p.timestamp)
      const valueEl = document.createElement('div')
      valueEl.className = 'chart-tooltip-value'
      valueEl.textContent = `${formatNumber(p.totalStaked, 2)} ALPH staked`
      tooltip!.append(dateEl, valueEl)

      // .chart-tooltip is `position: absolute` inside .chart-card (`position: relative`),
      // so its offsets must be relative to the card's box — not the document/viewport.
      const cardRect = card!.getBoundingClientRect()
      const rectBounds = svg!.getBoundingClientRect()
      const left = rectBounds.left - cardRect.left + (p.x / width) * rectBounds.width
      const top = rectBounds.top - cardRect.top + (p.y / H) * rectBounds.height
      const tooltipWidth = tooltip!.offsetWidth
      tooltip!.style.left = `${Math.min(Math.max(left - tooltipWidth / 2, 0), cardRect.width - tooltipWidth)}px`
      tooltip!.style.top = `${top - 14}px`
    }

    function hide(): void {
      crosshair!.setAttribute('style', 'opacity:0')
      dot!.setAttribute('style', 'opacity:0')
      tooltip!.style.opacity = '0'
    }

    hitArea.addEventListener('pointermove', (e) => handleMove(e.clientX))
    hitArea.addEventListener('pointerleave', hide)
  }

  draw()
  new ResizeObserver(() => draw()).observe(mount)
}
