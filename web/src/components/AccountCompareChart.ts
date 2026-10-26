/**
 * 多账号流量对比
 * ============================================================================
 * 横向条形图，按账号比较本账期已用流量占配额的比例。
 *
 * 与 `TrafficChart` 的分工：那张图回答「单个账号随时间怎么变」，这张图
 * 回答「谁的流量最多」。账号一多，逐张卡片看百分比就很难横向比较。
 *
 * 只注册 bar 图，不与折线图共享实例，避免两套坐标系互相污染。
 */

import * as echarts from 'echarts/core'
import { BarChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsType, EChartsCoreOption } from 'echarts/core'
import type { AccountOverview } from '@/api/client'
import { humanBytes } from '@/api/client'
import { el } from '@/lib/dom'

echarts.use([BarChart, GridComponent, TooltipComponent, CanvasRenderer])

/** 从 CSS 变量取计算后的颜色（Canvas 无法解析 `light-dark()`）。 */
const colorCache = new Map<string, string>()

function resolveColor(name: string): string {
  const cached = colorCache.get(name)
  if (cached) return cached
  const probe = document.createElement('span')
  probe.style.color = `var(${name})`
  probe.style.display = 'none'
  document.body.appendChild(probe)
  const computed = getComputedStyle(probe).color
  probe.remove()
  const value = computed || '#888888'
  colorCache.set(name, value)
  return value
}

/** 按百分比取色。 */
function toneColor(percent: number): string {
  if (percent >= 100) return resolveColor('--color-danger')
  if (percent >= 80) return resolveColor('--color-warn')
  return resolveColor('--color-brand')
}

/** 多账号对比图。 */
export class AccountCompareChart {
  readonly element: HTMLDivElement

  private readonly canvasHost: HTMLDivElement
  private readonly emptyState: HTMLDivElement

  private chart: EChartsType | null = null
  private observer: ResizeObserver | null = null
  private disposed = false
  private accounts: AccountOverview[] = []

  constructor() {
    this.canvasHost = el('div', { class: 'h-0 w-full opacity-0 transition-opacity' })
    this.emptyState = el('div', {
      class: 'flex h-40 flex-col items-center justify-center gap-2 text-xs',
      style: { color: 'var(--color-ink-subtle)' },
    })
    this.element = el('div', { class: 'relative' }, this.emptyState, this.canvasHost)
    this.renderEmpty()
  }

  mount(): void {
    this.ensureChart()
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => {
        if (!this.disposed) this.chart?.resize()
      })
      this.observer.observe(this.element)
    }
  }

  update(accounts: AccountOverview[]): void {
    // 只比较启用的账号；停用账号不参与流量控制，混进来反而干扰判断
    this.accounts = accounts.filter((account) => account.enabled)
    this.render()
  }

  dispose(): void {
    this.disposed = true
    this.observer?.disconnect()
    this.observer = null
    this.chart?.dispose()
    this.chart = null
  }

  private renderEmpty(): void {
    this.emptyState.textContent = '暂无启用的账号'
  }

  private ensureChart(): void {
    if (this.disposed) return
    if (!this.chart) {
      this.chart = echarts.init(this.canvasHost, undefined, { renderer: 'canvas' })
    }
    this.render()
  }

  private render(): void {
    if (this.disposed) return
    const accounts = this.accounts

    if (accounts.length === 0) {
      this.emptyState.classList.remove('hidden')
      this.canvasHost.className = 'h-0 w-full opacity-0'
      this.chart?.clear()
      this.renderEmpty()
      return
    }

    this.emptyState.classList.add('hidden')
    // 每条 40px，最少 120px，最多 360px
    const height = Math.min(Math.max(accounts.length * 40, 120), 360)
    this.canvasHost.className = 'w-full opacity-100 transition-opacity'
    this.canvasHost.style.height = `${height}px`

    if (!this.chart) return

    // 横向条形：类目轴在 y，按用量升序排列（ECharts 的 y 轴自下而上）
    const sorted = [...accounts].sort((a, b) => a.total_percent - b.total_percent)
    const names = sorted.map((account) => account.name)
    const values = sorted.map((account) => ({
      value: Number(account.total_percent.toFixed(2)),
      itemStyle: { color: toneColor(account.total_percent) },
      // 供 tooltip 使用
      domesticBytes: account.cdt_domestic_bytes,
      overseasBytes: account.cdt_overseas_bytes,
      domesticLimit: account.domestic_limit_gb,
      overseasLimit: account.overseas_limit_gb,
    }))

    const option: EChartsCoreOption = {
      animationDuration: 260,
      grid: { left: 8, right: 56, top: 8, bottom: 8, containLabel: true },
      tooltip: {
        trigger: 'item',
        backgroundColor: resolveColor('--color-surface'),
        borderColor: resolveColor('--color-line'),
        textStyle: { color: resolveColor('--color-ink'), fontSize: 12 },
        formatter: (params: unknown) => {
          const item = params as {
            name: string
            data: {
              domesticBytes: number
              overseasBytes: number
              domesticLimit: number
              overseasLimit: number
              value: number
            }
          }
          const data = item.data
          return [
            `<div style="font-weight:600;margin-bottom:2px">${escapeHtml(item.name)}</div>`,
            `内地 ${humanBytes(data.domesticBytes)} / ${data.domesticLimit} GB`,
            `非内地 ${humanBytes(data.overseasBytes)} / ${data.overseasLimit} GB`,
            `最高占比 ${data.value}%`,
          ].join('<br/>')
        },
      },
      xAxis: {
        type: 'value',
        max: (value: { max: number }) => Math.max(100, Math.ceil(value.max / 10) * 10),
        axisLabel: {
          color: resolveColor('--color-ink-subtle'),
          fontSize: 11,
          formatter: '{value}%',
        },
        splitLine: { lineStyle: { color: resolveColor('--color-line') } },
      },
      yAxis: {
        type: 'category',
        data: names,
        axisLabel: { color: resolveColor('--color-ink-muted'), fontSize: 12 },
        axisLine: { lineStyle: { color: resolveColor('--color-line') } },
        axisTick: { show: false },
      },
      series: [
        {
          type: 'bar',
          data: values,
          barMaxWidth: 18,
          itemStyle: { borderRadius: [0, 4, 4, 0] },
          label: {
            show: true,
            position: 'right',
            color: resolveColor('--color-ink-muted'),
            fontSize: 11,
            formatter: '{c}%',
          },
        },
      ],
    }

    this.chart.setOption(option, true)
    this.chart.resize()
  }
}

/** tooltip 里的账号名来自用户输入，必须转义。 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
