/**
 * 历史流量弹窗
 * ============================================================================
 * 点卡片上的历史按钮打开，切换「24 小时 / 30 天」两种粒度。
 *
 * 关键点：**时间轴要补全**。采样数据是稀疏的（同一小时内多次巡检只留一个点），
 * 直接把数据点连起来会让曲线在没采样的时段"跳"过去，看起来像是流量突变。
 * 因此这里固定生成 25 个整点槽位 / 31 个整日槽位，缺失的槽位保持 `null`，
 * 由 ECharts 断开线段（`connectNulls: false`），真实缺口一眼可见。
 */

import * as echarts from 'echarts/core'
import { BarChart, LineChart } from 'echarts/charts'
import {
  GridComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsType, EChartsCoreOption } from 'echarts/core'
import type { TrafficHistoryResponse, TrafficSample } from '@/api/client'
import { el, iconSvg, onEscape, replaceChildren } from '@/lib/dom'
import { icons } from '@/lib/icons'

echarts.use([
  LineChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  MarkLineComponent,
  CanvasRenderer,
])

const HOUR_MS = 60 * 60 * 1000

type Range = 'hourly' | 'daily'

interface DisplayPoint {
  at: number
  traffic: number | null
}

/** 把 CSS 变量解析成 Canvas 能用的具体颜色（`light-dark()` 需要这样绕）。 */
const colorCache = new Map<string, string>()

function parseRgb(value: string): { r: number; g: number; b: number } | null {
  const match = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i)
  if (!match) return null
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) }
}

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

/** 本地当天 00:00。 */
function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/**
 * 把稀疏采样铺到固定长度的槽位上。
 *
 * 24 小时：25 个整点槽（含当前整点），缺失留 `null`。
 * 30 天：31 个整日槽。
 */
function buildTimeline(data: TrafficSample[], range: Range): DisplayPoint[] {
  const slotCount = range === 'hourly' ? 25 : 31
  const step = range === 'hourly' ? HOUR_MS : 24 * HOUR_MS
  const align = range === 'hourly' ? (t: number) => Math.floor(t / step) * step : startOfLocalDay

  const latestPoint = data.reduce((latest, point) => Math.max(latest, point.recorded_at), 0)
  const end = Math.max(align(Date.now()), align(latestPoint))
  const values = new Map(data.map((point) => [align(point.recorded_at), point.traffic_gb]))

  return Array.from({ length: slotCount }, (_, index) => {
    const offset = slotCount - 1 - index
    const at = range === 'hourly' ? end - offset * step : startOfLocalDay(end - offset * step)
    return { at, traffic: values.get(at) ?? null }
  })
}

function hourLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function dayLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
  })
}

/** 历史流量弹窗。 */
export class HistoryModal {
  readonly element: HTMLDivElement

  private readonly title: HTMLHeadingElement
  private readonly subtitle: HTMLParagraphElement
  private readonly chartHost: HTMLDivElement
  private readonly emptyState: HTMLDivElement
  private readonly rangeButtons = new Map<Range, HTMLButtonElement>()

  private chart: EChartsType | null = null
  private data: TrafficHistoryResponse | null = null
  private range: Range = 'hourly'
  private removeEsc: (() => void) | null = null

  constructor() {
    this.title = el('h2', { class: 'text-sm font-semibold' })
    this.subtitle = el('p', {
      class: 'mt-0.5 text-xs',
      style: { color: 'var(--color-ink-subtle)' },
    })
    this.chartHost = el('div', { class: 'h-[320px] w-full', role: 'img' })
    this.emptyState = el(
      'div',
      {
        class: 'hidden h-[320px] place-items-center text-sm',
        style: { color: 'var(--color-ink-subtle)' },
      },
      el('span', { text: '暂无采样数据' }),
    )

    const segmented = el('div', {
      class: 'inline-flex overflow-hidden rounded-lg border',
      style: { borderColor: 'var(--color-line)' },
    })
    for (const [key, label] of [
      ['hourly', '24 小时'],
      ['daily', '30 天'],
    ] as [Range, string][]) {
      const button = el(
        'button',
        {
          class: 'px-3 py-1 text-xs',
          type: 'button',
          on: { click: () => this.setRange(key) },
        },
        el('span', { text: label }),
      ) as HTMLButtonElement
      this.rangeButtons.set(key, button)
      segmented.append(button)
    }

    this.element = el(
      'div',
      {
        class: 'overlay hidden',
        on: {
          click: (event) => {
            if (event.target === this.element) this.close()
          },
        },
      },
      el(
        'div',
        {
          class: 'card w-full max-w-3xl overflow-hidden',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': '历史流量',
        },
        el(
          'header',
          {
            class: 'flex items-start justify-between gap-3 border-b px-5 py-3',
            style: { borderColor: 'var(--color-line)' },
          },
          el('div', {}, this.title, this.subtitle),
          el(
            'div',
            { class: 'flex items-center gap-3' },
            segmented,
            el(
              'button',
              {
                class: 'btn btn-ghost btn-sm',
                type: 'button',
                'aria-label': '关闭',
                on: { click: () => this.close() },
              },
              iconSvg(icons.close, 14),
            ),
          ),
        ),
        el('div', { class: 'px-5 py-4' }, this.chartHost, this.emptyState),
      ),
    )

    this.syncRangeButtons()
  }

  /** 打开并展示某账号的历史数据。 */
  open(name: string, data: TrafficHistoryResponse): void {
    this.title.textContent = name
    this.data = data
    this.range = 'hourly'
    this.syncRangeButtons()

    const quotaText = data.quota_gb > 0 ? `免费额度 ${data.quota_gb} GB` : ''
    const thresholdText =
      data.traffic_threshold_gb > 0
        ? `阈值 ${data.traffic_threshold_gb} GB`
        : '未设告警阈值'
    this.subtitle.textContent = [data.billing_month, quotaText, thresholdText]
      .filter(Boolean)
      .join(' · ')

    this.element.classList.remove('hidden')
    this.element.style.display = 'flex'
    document.body.style.overflow = 'hidden'
    this.removeEsc = onEscape(() => this.close())

    // 弹窗刚显示时容器还没尺寸，等一帧再 init
    requestAnimationFrame(() => this.render())
  }

  /** 关闭弹窗。 */
  close(): void {
    this.element.classList.add('hidden')
    this.element.style.display = 'none'
    document.body.style.overflow = ''
    this.removeEsc?.()
    this.removeEsc = null
    this.chart?.dispose()
    this.chart = null
  }

  private setRange(range: Range): void {
    if (this.range === range) return
    this.range = range
    this.syncRangeButtons()
    this.render()
  }

  private syncRangeButtons(): void {
    for (const [key, button] of this.rangeButtons) {
      const active = key === this.range
      button.classList.toggle('bg-(--color-surface-muted)', active)
      button.style.color = active ? 'var(--color-ink)' : 'var(--color-ink-muted)'
      button.style.fontWeight = active ? '600' : '400'
    }
  }

  private render(): void {
    if (!this.data) return
    const points = this.range === 'hourly' ? this.data.history.hourly : this.data.history.daily
    const timeline = buildTimeline(points, this.range)
    const sampled = timeline.filter((point) => point.traffic !== null).length

    const hasData = sampled > 0
    this.emptyState.classList.toggle('hidden', hasData)
    this.emptyState.classList.toggle('grid', !hasData)
    this.chartHost.classList.toggle('hidden', !hasData)
    if (!hasData) {
      this.chart?.dispose()
      this.chart = null
      return
    }

    if (!this.chart) {
      this.chart = echarts.init(this.chartHost)
    }
    this.chart.setOption(this.buildOption(timeline, sampled), true)
  }

  private buildOption(timeline: DisplayPoint[], sampled: number): EChartsCoreOption {
    const ink = resolveColor('--color-ink')
    const subtle = resolveColor('--color-ink-subtle')
    const line = resolveColor('--color-line')
    const brand = resolveColor('--color-brand')
    const danger = resolveColor('--color-danger')
    const surface = resolveColor('--color-surface')

    const formatLabel = this.range === 'hourly' ? hourLabel : dayLabel
    const values = timeline.map((point) => point.traffic)
    const maxValue = values.reduce<number>((max, value) => Math.max(max, value ?? 0), 0)

    const threshold = this.data?.traffic_threshold_gb ?? 0
    const quota = this.data?.quota_gb ?? 0

    const markLines: Record<string, unknown>[] = []
    if (quota > 0) {
      markLines.push({
        yAxis: quota,
        lineStyle: { color: danger, type: 'dashed', width: 1 },
        label: {
          formatter: `免费额度 ${quota} GB`,
          color: danger,
          fontSize: 10,
          position: 'insideEndTop',
        },
      })
    }
    if (threshold > 0 && threshold !== quota) {
      markLines.push({
        yAxis: threshold,
        lineStyle: { color: brand, type: 'dashed', width: 1 },
        label: {
          formatter: `阈值 ${threshold} GB`,
          color: brand,
          fontSize: 10,
          position: 'insideStartTop',
        },
      })
    }

    // 数据点很少时把点画出来，否则一根孤零零的线看不出是"单点"还是"连续"
    const showDots = sampled <= 4
    const axisStyle = {
      tickLine: false,
      axisLine: false,
      tick: { fill: subtle, fontSize: 11 },
    }

    const common = {
      animation: false,
      grid: { top: 16, right: 20, bottom: 8, left: 8, containLabel: true },
      tooltip: {
        trigger: 'axis',
        backgroundColor: surface,
        borderColor: line,
        textStyle: { color: ink, fontSize: 12 },
        formatter: (params: unknown) => {
          const list = Array.isArray(params) ? params : [params]
          const first = list[0] as { dataIndex?: number } | undefined
          const point = timeline[first?.dataIndex ?? 0]
          if (!point || point.traffic === null) return ''
          const when = new Date(point.at)
          const stamp =
            this.range === 'hourly'
              ? `${when.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })} ${hourLabel(point.at)}`
              : when.toLocaleDateString('zh-CN')
          return `<div style="font-weight:600;margin-bottom:2px">${stamp}</div>累计 ${point.traffic.toFixed(3)} GB`
        },
      },
      xAxis: {
        type: 'category' as const,
        boundaryGap: this.range === 'daily',
        data: timeline.map((point) => formatLabel(point.at)),
        axisLabel: { ...axisStyle.tick, interval: 'auto', hideOverlap: true },
        axisTick: { show: false },
        axisLine: { lineStyle: { color: line } },
      },
      yAxis: {
        type: 'value' as const,
        min: 0,
        // 给 markLine 留出空间：额度线可能远高于实际用量
        max: Math.max(maxValue, quota > 0 ? quota : 0) * 1.08 || undefined,
        axisLabel: {
          ...axisStyle.tick,
          formatter: (value: number) => Number(value.toFixed(3)).toString(),
        },
        splitLine: { lineStyle: { color: line } },
      },
    }

    if (this.range === 'daily') {
      return {
        ...common,
        series: [
          {
            type: 'bar',
            name: '累计流量',
            data: values,
            barMaxWidth: 26,
            itemStyle: { color: ink, borderRadius: [4, 4, 0, 0] },
            markLine: markLines.length > 0 ? { silent: true, symbol: 'none', data: markLines } : undefined,
          },
        ],
      } as EChartsCoreOption
    }

    return {
      ...common,
      series: [
        {
          type: 'line',
          name: '累计流量',
          data: values,
          // 关键：缺口不连线，避免把没采样的时段画成平滑曲线
          connectNulls: false,
          smooth: 0.2,
          showSymbol: showDots,
          symbolSize: 5,
          lineStyle: { width: 2, color: ink },
          itemStyle: { color: ink },
          markLine: markLines.length > 0 ? { silent: true, symbol: 'none', data: markLines } : undefined,
        },
      ],
    } as EChartsCoreOption
  }

  /** 销毁。 */
  dispose(): void {
    this.close()
    replaceChildren(this.element)
  }
}
