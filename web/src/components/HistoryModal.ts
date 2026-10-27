/**
 * 历史流量弹窗
 * ============================================================================
 * 结构照搬上游 `HistoryModal`：
 *
 *   modal-layer
 *   ├ modal-scrim（点击关闭）
 *   └ chart-modal
 *     ├ header   TRAFFIC HISTORY / 账号名 / 关闭
 *     ├ segmented 24 小时 · 30 天
 *     └ chart-area
 *
 * 关键点：**时间轴要补全**。采样是稀疏的（同一小时内多次巡检只留一个点），
 * 直接把数据点连起来会让曲线在没采样的时段"跳"过去，看起来像流量突变。
 * 因此固定生成 25 个整点槽 / 31 个整日槽，缺失槽位保持 `null`，
 * 由 `connectNulls: false` 断开线段，真实缺口一眼可见。
 */

import type { EChartsType, EChartsCoreOption } from 'echarts/core'
import type { TrafficHistoryResponse, TrafficSample } from '@/api/client'
import { el, eyebrow, iconButton, iconSvg, onEscape, replaceChildren, segmented } from '@/lib/dom'
import { icons } from '@/lib/icons'

/**
 * echarts 按需加载。
 *
 * 图表模块（含 echarts 本体）压缩后约 500 kB，静态 import 会被打进主 bundle
 * 拖慢首屏，而只有点「历史流量」时才用得到。这里做成单例 Promise：
 * 首次打开才开始下载，后续复用同一份。
 */
type EChartsModule = typeof import('@/lib/echarts')

let echartsPromise: Promise<EChartsModule['default']> | null = null

function loadECharts(): Promise<EChartsModule['default']> {
  if (!echartsPromise) {
    echartsPromise = import('@/lib/echarts').then((module) => module.default)
  }
  return echartsPromise
}

/** 悬停历史按钮时预热，点击时就不必等下载。 */
export function preloadHistoryChart(): void {
  void loadECharts()
}

const HOUR_MS = 60 * 60 * 1000

type Range = 'hourly' | 'daily'

interface DisplayPoint {
  at: number
  traffic: number | null
}

/** 上游图表使用的固定色值，不跟随主题变量。 */
const INK = '#111315'
const GRID = 'rgba(173, 178, 184, .32)'
const AXIS_TEXT = '#737780'

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
  private readonly loadingState: HTMLDivElement
  private readonly rangeHost: HTMLDivElement

  private chart: EChartsType | null = null
  /** 递增序号，用于丢弃过期的异步绘制结果 */
  private renderToken = 0
  private data: TrafficHistoryResponse | null = null
  private range: Range = 'hourly'
  private removeEsc: (() => void) | null = null

  constructor() {
    this.title = el('h2', {})
    this.subtitle = el('p', { class: 'eyebrow', style: { marginBottom: '0' } })
    this.chartHost = el('div', { style: { height: '100%' }, role: 'img' })
    this.emptyState = el(
      'div',
      { class: 'subtle-empty' },
      iconSvg(icons.chart, 28),
      el('span', { text: '等待采样数据' }),
    )
    this.emptyState.style.height = '100%'
    this.emptyState.hidden = true

    // 数据与图表模块加载中时先显示这个，避免弹窗空白
    this.loadingState = el(
      'div',
      { class: 'subtle-empty' },
      iconSvg(icons.chart, 28, 'spin'),
      el('span', { text: '加载中…' }),
    )
    this.loadingState.style.height = '100%'
    this.loadingState.hidden = true

    this.rangeHost = el('div', {})

    const body = el(
      'div',
      { class: 'chart-area' },
      this.chartHost,
      this.emptyState,
      this.loadingState,
    )

    this.element = el(
      'div',
      { class: 'modal-layer', hidden: true },
      el('div', { class: 'modal-scrim', on: { click: () => this.close() } }),
      el(
        'section',
        {
          class: 'glass-card chart-modal',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': '历史流量',
        },
        el(
          'header',
          {},
          el('div', {}, eyebrow('TRAFFIC HISTORY'), this.title, this.subtitle),
          iconButton({
            label: '关闭',
            icon: icons.close,
            onClick: () => this.close(),
          }),
        ),
        this.rangeHost,
        body,
      ),
    )
  }

  /**
   * 先行打开弹窗并显示加载态。
   *
   * 点击到图表出现原本要等两件事：拉数据和下载 echarts chunk。
   * 先开弹窗能让点击立刻有反馈，后两者并行进行。
   */
  show(name: string): void {
    this.title.textContent = name
    this.subtitle.textContent = ''
    this.data = null
    this.range = 'hourly'
    replaceChildren(this.rangeHost)

    this.chart?.dispose()
    this.chart = null
    this.chartHost.hidden = true
    this.emptyState.hidden = true
    this.loadingState.hidden = false

    this.element.hidden = false
    document.body.style.overflow = 'hidden'
    this.removeEsc = onEscape(() => this.close())

    // 同时开始下载图表模块，数据到时通常已就绪
    void loadECharts()
  }

  /** 打开并展示某账号的历史数据。 */
  open(name: string, data: TrafficHistoryResponse): void {
    this.loadingState.hidden = true
    this.title.textContent = name
    this.data = data
    this.range = 'hourly'

    const quotaText = data.quota_gb > 0 ? `免费额度 ${data.quota_gb} GB` : ''
    const thresholdText =
      data.traffic_threshold_gb > 0 ? `阈值 ${data.traffic_threshold_gb} GB` : '未设阈值'
    this.subtitle.textContent = [data.billing_month, quotaText, thresholdText]
      .filter(Boolean)
      .join(' · ')

    this.renderRangeControl()
    this.element.hidden = false
    document.body.style.overflow = 'hidden'
    this.removeEsc = onEscape(() => this.close())

    // 弹窗刚显示时容器还没尺寸，等一帧再 init
    requestAnimationFrame(() => this.render())
  }

  /** 关闭弹窗。 */
  close(): void {
    this.element.hidden = true
    document.body.style.overflow = ''
    this.removeEsc?.()
    this.removeEsc = null
    // 让正在等待 echarts 的绘制自然作废
    this.renderToken += 1
    this.chart?.dispose()
    this.chart = null
  }

  private setRange(range: Range): void {
    if (this.range === range) return
    this.range = range
    this.renderRangeControl()
    this.render()
  }

  private renderRangeControl(): void {
    replaceChildren(
      this.rangeHost,
      segmented<Range>({
        value: this.range,
        items: [
          ['hourly', '24 小时'],
          ['daily', '30 天'],
        ],
        onChange: (value) => this.setRange(value),
      }),
    )
  }

  private render(): void {
    if (!this.data) return
    const points = this.range === 'hourly' ? this.data.history.hourly : this.data.history.daily
    const timeline = buildTimeline(points, this.range)
    const sampled = timeline.filter((point) => point.traffic !== null).length

    const hasData = sampled > 0
    this.emptyState.hidden = hasData
    this.chartHost.hidden = !hasData
    if (!hasData) {
      this.chart?.dispose()
      this.chart = null
      return
    }

    void this.paintChart(timeline, sampled)
  }

  /** 等 echarts 就绪后绘制。期间先显示加载态，避免弹窗空白。 */
  private async paintChart(timeline: DisplayPoint[], sampled: number): Promise<void> {
    const token = ++this.renderToken
    this.chartHost.classList.add('is-loading')

    const echarts = await loadECharts()

    // 等待期间可能已关闭弹窗或切了范围，丢弃这次结果
    if (token !== this.renderToken || this.element.hidden) return

    this.chartHost.classList.remove('is-loading')
    if (!this.chart) {
      this.chart = echarts.init(this.chartHost)
    }
    this.chart.setOption(this.buildOption(timeline, sampled), true)
    this.chart.resize()
  }

  private buildOption(timeline: DisplayPoint[], sampled: number): EChartsCoreOption {
    const formatLabel = this.range === 'hourly' ? hourLabel : dayLabel
    const values = timeline.map((point) => point.traffic)
    const maxValue = values.reduce<number>((max, value) => Math.max(max, value ?? 0), 0)

    const tickStep = this.range === 'hourly' ? 4 : 5
    const axis = {
      tickLine: false,
      axisLine: false,
      tick: { fill: AXIS_TEXT, fontSize: 11 },
    }

    const common = {
      animation: false,
      grid: { top: 18, right: 20, bottom: 6, left: 6, containLabel: true },
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(255, 255, 255, .96)',
        borderColor: 'rgba(173, 178, 184, .45)',
        borderWidth: 1,
        textStyle: { color: INK, fontSize: 12 },
        extraCssText:
          'border-radius:10px;box-shadow:0 16px 32px -20px rgba(15,23,42,.36)',
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
        axisLabel: { ...axis.tick, interval: tickStep },
        axisTick: { show: false },
        axisLine: { show: false },
      },
      yAxis: {
        type: 'value' as const,
        min: 0,
        // 只按实际数据取值域：额度可能远高于当月累计，撑开会让曲线贴底
        max: maxValue > 0 ? maxValue * 1.15 : undefined,
        splitNumber: 4,
        axisLabel: {
          ...axis.tick,
          formatter: (value: number) => Number(value.toFixed(2)).toString(),
        },
        splitLine: { lineStyle: { color: GRID } },
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
            itemStyle: { color: INK, borderRadius: [4, 4, 0, 0] },
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
          showSymbol: sampled <= 4,
          symbolSize: 6,
          lineStyle: { width: 2.25, color: INK },
          itemStyle: { color: INK, borderColor: '#fff', borderWidth: 2 },
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
