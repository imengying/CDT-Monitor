/**
 * 流量趋势图（对应原版 `TrafficChart.vue`）
 * ============================================================================
 * 基于 ECharts 的流量趋势图：国内 / 海外双折线 + 合计虚线 + 配额提示线。
 *
 * 工程要点：
 * * **按需引入**：只注册 line + grid/tooltip/legend/markLine/dataZoom + Canvas，
 *   产物远小于全量 ECharts。
 * * **生命周期显式管理**：`init` 在容器首次获得尺寸时执行，`dispose` 在
 *   组件销毁时调用，避免 canvas 泄漏。
 * * **主题跟随**：从 CSS 变量读当前配色；系统主题切换时重建 option。
 * * **空数据**：容器保持挂载（否则 echarts 无 DOM 可测量），仅隐藏高度。
 */

import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsType, EChartsCoreOption } from 'echarts/core'
import { bytesToGb, formatTime, humanBytes } from '@/api/client'
import type { HistoryBucket, TrafficHistoryResponse } from '@/api/client'
import { el, iconSvg, replaceChildren } from '@/lib/dom'
import { icons } from '@/lib/icons'

echarts.use([
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  DataZoomComponent,
  CanvasRenderer,
])

interface Palette {
  ink: string
  muted: string
  subtle: string
  line: string
  brand: string
  ok: string
  danger: string
  surface: string
}

/**
 * 把 CSS 变量解析成 Canvas 能吃的具体颜色。
 *
 * 注意：**不能**直接读 `getPropertyValue('--color-brand')`。
 * 我们的主题变量用了 `light-dark(#2563eb, #60a5fa)`，自定义属性返回的是
 * 这段原始文本；Canvas 的 `addColorStop` 无法解析它（会抛 SyntaxError）。
 *
 * 正确做法是把变量挂到一个探测元素的 `color` 上，读**计算后的** `color`，
 * 浏览器会给出已解析的 `rgb(r, g, b)`。
 */
const colorCache = new Map<string, string>()

function parseRgb(value: string): { r: number; g: number; b: number } | null {
  const match = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i)
  if (!match) return null
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) }
}

/** 解析 CSS 变量为 `rgb()` 或 `rgba()` 字符串。`alpha` 为 0..1。 */
function resolveColor(variable: string, alpha = 1): string {
  const key = `${variable}@${alpha}`
  const cached = colorCache.get(key)
  if (cached) return cached

  const fallback = alpha >= 1 ? '#64748b' : `rgba(100, 116, 139, ${alpha})`

  const probe = document.createElement('span')
  probe.style.cssText = `color: var(${variable}); display: none;`
  document.body.append(probe)
  const computed = getComputedStyle(probe).color
  probe.remove()

  const rgb = parseRgb(computed)
  if (!rgb) return fallback

  const result =
    alpha >= 1 ? `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})` : `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`
  colorCache.set(key, result)
  return result
}

/** 从 CSS 变量读主题色（已解析为具体颜色）。 */
function palette(): Palette {
  return {
    ink: resolveColor('--color-ink'),
    muted: resolveColor('--color-ink-muted'),
    subtle: resolveColor('--color-ink-subtle'),
    line: resolveColor('--color-line'),
    brand: resolveColor('--color-brand'),
    ok: resolveColor('--color-ok'),
    danger: resolveColor('--color-danger'),
    surface: resolveColor('--color-surface'),
  }
}

/** 流量趋势图组件。 */
export class TrafficChart {
  readonly element: HTMLDivElement

  private readonly canvasHost: HTMLDivElement
  private readonly emptyState: HTMLDivElement
  private readonly loadingOverlay: HTMLDivElement
  private readonly summaryRow: HTMLDivElement

  private chart: EChartsType | null = null
  private observer: ResizeObserver | null = null
  private mediaQuery: MediaQueryList | null = null
  private disposed = false

  private data: TrafficHistoryResponse | null = null
  private bucket: HistoryBucket = 'hour'
  private loading = false

  constructor() {
    this.canvasHost = el('div', { class: 'h-0 w-full opacity-0 transition-opacity' })
    this.emptyState = el('div', {
      class: 'flex h-64 flex-col items-center justify-center gap-2 text-xs',
      style: { color: 'var(--color-ink-subtle)' },
    })
    this.loadingOverlay = el('div', {
      class: 'absolute inset-0 hidden items-center justify-center rounded-lg',
      style: { backgroundColor: 'color-mix(in oklab, var(--color-surface) 72%, transparent)' },
    })
    this.summaryRow = el('div', {
      class: 'mt-1 hidden flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[0.8125rem]',
      style: { color: 'var(--color-ink-subtle)' },
    })
    this.element = el(
      'div',
      { class: 'relative' },
      this.emptyState,
      this.canvasHost,
      this.loadingOverlay,
      this.summaryRow,
    )

    this.renderEmptyState()
  }

  /** 挂载后初始化（需要容器已在 DOM 中才能测量尺寸）。 */
  mount(): void {
    this.ensureChart()
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => {
        if (!this.disposed) this.chart?.resize()
      })
      this.observer.observe(this.element)
    }
    this.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    this.mediaQuery.addEventListener('change', this.onThemeChange)
  }

  private readonly onThemeChange = (): void => {
    // 主题变了，之前解析出的颜色全部作废
    colorCache.clear()
    this.render()
  }

  private ensureChart(): void {
    if (this.disposed) return
    if (!this.chart) {
      this.chart = echarts.init(this.canvasHost, undefined, { renderer: 'canvas' })
    }
    this.render()
  }

  /** 更新数据。 */
  setData(data: TrafficHistoryResponse | null, bucket: HistoryBucket): void {
    this.data = data
    this.bucket = bucket
    this.renderEmptyState()
    this.renderSummary()
    this.render()
  }

  /** 更新加载状态。 */
  setLoading(loading: boolean): void {
    this.loading = loading
    this.loadingOverlay.classList.toggle('hidden', !loading)
    this.loadingOverlay.classList.toggle('flex', loading)
    replaceChildren(
      this.loadingOverlay,
      iconSvg(icons.spinner, 18, 'animate-spin'),
    )
  }

  /** 空状态渲染。 */
  private renderEmptyState(): void {
    const empty = !this.data || this.data.points.length === 0

    if (empty && !this.loading) {
      this.emptyState.classList.remove('hidden')
      replaceChildren(
        this.emptyState,
        iconSvg(icons.chart, 22),
        el('span', { text: '暂无历史采样数据' }),
        el('span', {
          text: '等待下一次 Cron 巡检（每 15 分钟一次）后即可看到趋势',
          style: { fontSize: '10px', opacity: '0.75' },
        }),
      )
    } else {
      this.emptyState.classList.add('hidden')
      this.emptyState.replaceChildren()
    }

    this.canvasHost.className = empty
      ? 'h-0 w-full opacity-0 transition-opacity'
      : 'h-64 w-full opacity-100 transition-opacity'
    if (!empty) {
      // 容器从 0 高度变为固定高度后需要重新测量
      requestAnimationFrame(() => this.chart?.resize())
    }
  }

  /** 摘要行。 */
  private renderSummary(): void {
    const points = this.data?.points ?? []
    if (points.length === 0) {
      this.summaryRow.classList.add('hidden')
      this.summaryRow.classList.remove('flex')
      return
    }

    const last = points[points.length - 1]
    this.summaryRow.classList.remove('hidden')
    this.summaryRow.classList.add('flex')
    replaceChildren(
      this.summaryRow,
      el('span', { text: `${points.length} 个采样点` }),
      el('span', { text: `最新：国内 ${humanBytes(last.domestic_bytes)}` }),
      el('span', { text: `海外 ${humanBytes(last.overseas_bytes)}` }),
      el('span', { class: 'opacity-70', text: formatTime(last.recorded_at) }),
    )
  }

  /** 渲染图表。 */
  private render(): void {
    if (!this.chart || this.disposed) return

    const points = this.data?.points ?? []
    if (points.length === 0) {
      this.chart.clear()
      return
    }

    this.chart.setOption(this.buildOption(), true)
  }

  /** 组装 ECharts option。 */
  private buildOption(): EChartsCoreOption {
    const colors = palette()
    const points = this.data?.points ?? []
    const domesticLimitGb = this.data?.domestic_limit_gb ?? 0
    const overseasLimitGb = this.data?.overseas_limit_gb ?? 0
    const exceeded = this.data?.threshold_triggered ?? false

    const labels = points.map((point) =>
      this.bucket === 'hour' ? formatTime(point.recorded_at) : formatTime(point.recorded_at).slice(5, 10),
    )
    const domestic = points.map((point) => Number(bytesToGb(point.domestic_bytes).toFixed(3)))
    const overseas = points.map((point) => Number(bytesToGb(point.overseas_bytes).toFixed(3)))
    const total = points.map((point) => Number(bytesToGb(point.total_bytes).toFixed(3)))

    const domesticColor = exceeded ? colors.danger : colors.brand

    const tooltipFormatter = (params: unknown): string => {
      const list = Array.isArray(params) ? params : [params]
      if (list.length === 0) return ''
      const first = list[0] as { dataIndex?: number }
      const index = first.dataIndex ?? 0
      const point = points[index]
      if (!point) return ''

      const rows = list
        .map((raw) => {
          const item = raw as { marker?: string; seriesName?: string; data?: number }
          const value = typeof item.data === 'number' ? item.data.toFixed(2) : '—'
          return `<div style="display:flex;justify-content:space-between;gap:14px;margin-top:3px">
            <span>${item.marker ?? ''}${item.seriesName ?? ''}</span>
            <span style="font-variant-numeric:tabular-nums;font-weight:600">${value} GB</span>
          </div>`
        })
        .join('')

      return `<div style="font-size:11px;color:${colors.muted}">${formatTime(point.recorded_at)}</div>${rows}`
    }

    return {
      animationDuration: 420,
      grid: { left: 8, right: 16, top: 40, bottom: points.length > 30 ? 28 : 8, containLabel: true },
      tooltip: {
        trigger: 'axis',
        backgroundColor: colors.surface,
        borderColor: colors.line,
        borderWidth: 1,
        padding: [8, 10],
        textStyle: { color: colors.ink, fontSize: 12 },
        axisPointer: {
          type: 'line',
          lineStyle: { color: colors.subtle, width: 1, type: 'dashed' },
        },
        formatter: tooltipFormatter,
      },
      legend: {
        top: 4,
        right: 0,
        icon: 'roundRect',
        itemWidth: 10,
        itemHeight: 4,
        itemGap: 14,
        textStyle: { color: colors.muted, fontSize: 11 },
      },
      xAxis: {
        type: 'category',
        data: labels,
        boundaryGap: false,
        axisLine: { lineStyle: { color: colors.line } },
        axisTick: { show: false },
        axisLabel: { color: colors.subtle, fontSize: 10, hideOverlap: true },
      },
      yAxis: {
        type: 'value',
        name: 'GB',
        nameTextStyle: { color: colors.subtle, fontSize: 10, padding: [0, 0, 0, -4] },
        min: 0,
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: colors.line, type: 'dashed' } },
        axisLabel: { color: colors.subtle, fontSize: 10 },
      },
      dataZoom:
        points.length > 30
          ? [
              { type: 'inside', throttle: 60 },
              {
                type: 'slider',
                height: 14,
                bottom: 0,
                borderColor: 'transparent',
                backgroundColor: colors.line,
                fillerColor: resolveColor('--color-brand', 0.13),
                handleStyle: { color: colors.brand },
                textStyle: { color: colors.subtle, fontSize: 10 },
              },
            ]
          : [],
      series: [
        {
          name: '国内',
          type: 'line',
          smooth: 0.24,
          showSymbol: false,
          lineStyle: { width: 2, color: domesticColor },
          itemStyle: { color: domesticColor },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: resolveColor(exceeded ? '--color-danger' : '--color-brand', 0.19) },
              { offset: 1, color: resolveColor(exceeded ? '--color-danger' : '--color-brand', 0) },
            ]),
          },
          data: domestic,
        },
        {
          name: '海外',
          type: 'line',
          smooth: 0.24,
          showSymbol: false,
          lineStyle: { width: 2, color: colors.ok },
          itemStyle: { color: colors.ok },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: resolveColor('--color-ok', 0.19) },
              { offset: 1, color: resolveColor('--color-ok', 0) },
            ]),
          },
          data: overseas,
        },
        {
          name: '合计',
          type: 'line',
          smooth: 0.24,
          showSymbol: false,
          lineStyle: { width: 1.5, type: 'dotted', color: colors.muted },
          itemStyle: { color: colors.muted },
          data: total,
          markLine:
            domesticLimitGb > 0 || overseasLimitGb > 0
              ? {
                  silent: true,
                  symbol: 'none',
                  lineStyle: { color: colors.danger, type: 'dashed', width: 1 },
                  data: [
                    ...(domesticLimitGb > 0
                      ? [
                          {
                            yAxis: domesticLimitGb,
                            label: {
                              formatter: `内地 ${domesticLimitGb} GB`,
                              color: colors.danger,
                              fontSize: 10,
                              position: 'insideEndTop' as const,
                            },
                          },
                        ]
                      : []),
                    ...(overseasLimitGb > 0
                      ? [
                          {
                            yAxis: overseasLimitGb,
                            label: {
                              formatter: `非内地 ${overseasLimitGb} GB`,
                              color: colors.danger,
                              fontSize: 10,
                              position: 'insideEndBottom' as const,
                            },
                          },
                        ]
                      : []),
                  ],
                }
              : undefined,
        },
      ],
    } as EChartsCoreOption
  }

  /** 销毁。 */
  dispose(): void {
    this.disposed = true
    this.observer?.disconnect()
    this.observer = null
    this.mediaQuery?.removeEventListener('change', this.onThemeChange)
    this.mediaQuery = null
    this.chart?.dispose()
    this.chart = null
  }
}
