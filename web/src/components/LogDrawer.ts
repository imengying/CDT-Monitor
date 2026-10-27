/**
 * 日志弹窗
 * ============================================================================
 * 结构照搬上游 `LogSettings` + `log-list`：标题区、类型筛选 + 关键词搜索、
 * 逐条日志（左侧圆点、右上时间）。
 *
 * 配色规则：
 *   熔断 / 失败 / 拦截 -> 红
 *   通知 / 日报        -> 绿
 *   定时 / 保活 / 手动 -> 蓝
 *   其它（审计等）      -> 灰
 */

import { api, ApiError, formatTime, type ActionLog } from '@/api/client'
import { el, eyebrow, iconButton, iconSvg, onEscape, replaceChildren, segmented } from '@/lib/dom'
import { icons } from '@/lib/icons'

/** action_type 的中文标签（未收录的直出原文）。 */
const ACTION_LABELS: Record<string, string> = {
  threshold_triggered: '流量熔断',
  threshold_stop: '熔断停机',
  threshold_stop_failed: '熔断停机失败',
  schedule_start: '定时开机',
  schedule_start_failed: '定时开机失败',
  schedule_start_blocked: '定时开机被拦',
  schedule_stop: '定时关机',
  schedule_stop_failed: '定时关机失败',
  spot_keep_alive: '抢占式保活',
  spot_keep_alive_failed: '抢占式保活失败',
  keep_alive_enabled: '开启保活',
  keep_alive_disabled: '关闭保活',
  manual_start: '手动开机',
  manual_start_failed: '手动开机失败',
  manual_stop: '手动关机',
  manual_stop_failed: '手动关机失败',
  refresh_warning: '采集告警',
  refresh_failed: '采集失败',
  account_created: '新增账号',
  account_updated: '更新账号',
  account_deleted: '删除账号',
  login_success: '登录成功',
  login_failed: '登录失败',
  login_turnstile_failed: '人机校验失败',
  notify_failed: '通知失败',
  notify_test_all: '测试通知',
  notify_test_telegram: '测试 Telegram',
  notify_test_bark: '测试 Bark',
  daily_report: '日报推送',
  daily_report_manual: '手动日报',
  settings_telegram: 'Telegram 设置',
  settings_bark: 'Bark 设置',
}

/** 日志圆点色调。 */
function dotClass(actionType: string): string {
  if (
    actionType.includes('failed') ||
    actionType.includes('threshold') ||
    actionType.includes('blocked')
  ) {
    return 'log-dot--error'
  }
  if (actionType.startsWith('notify') || actionType.includes('report')) {
    return 'log-dot--info'
  }
  return ''
}

const FILTERS = [
  ['', '全部'],
  ['login', '登录'],
  ['threshold', '熔断'],
  ['schedule', '定时'],
  ['spot', '保活'],
  ['manual', '手动'],
  ['notify', '通知'],
] as const

type FilterKey = (typeof FILTERS)[number][0]

/** 日志弹窗控制器。 */
export class LogDrawer {
  readonly element: HTMLDivElement

  private readonly listHost: HTMLDivElement
  private readonly searchInput: HTMLInputElement
  private readonly errorBox: HTMLDivElement
  private readonly filterHost: HTMLDivElement
  private readonly refreshButton: HTMLButtonElement

  private logs: ActionLog[] = []
  private keyword = ''
  private filter: FilterKey = ''
  private loading = false
  private removeEscListener: (() => void) | null = null

  constructor() {
    this.listHost = el('div', { class: 'log-list' })
    this.filterHost = el('div', {})

    this.errorBox = el('div', { class: 'inline-error' })
    this.errorBox.hidden = true

    this.searchInput = el('input', {
      type: 'search',
      placeholder: '按账号、实例或内容筛选…',
    }) as HTMLInputElement
    this.searchInput.addEventListener('input', () => {
      this.keyword = this.searchInput.value
      this.renderList()
    })

    this.refreshButton = iconButton({
      label: '刷新日志',
      icon: icons.refresh,
      onClick: () => void this.load(),
    })

    this.element = el(
      'div',
      { class: 'modal-layer', hidden: true },
      el('div', { class: 'modal-scrim', on: { click: () => this.close() } }),
      el(
        'section',
        {
          class: 'glass-card log-drawer',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': '操作日志',
        },
        el(
          'header',
          {},
          el('div', {}, eyebrow('ACTION LOG'), el('h2', { text: '操作日志' })),
          el(
            'div',
            { class: 'control-group' },
            this.refreshButton,
            iconButton({ label: '关闭', icon: icons.close, onClick: () => this.close() }),
          ),
        ),
        el('div', { class: 'log-toolbar' }, this.filterHost, this.searchInput),
        this.errorBox,
        el('div', { class: 'log-body' }, this.listHost),
      ),
    )

    this.searchInput.classList.add('search-input')
    this.renderFilter()
  }

  private renderFilter(): void {
    replaceChildren(
      this.filterHost,
      segmented<FilterKey>({
        value: this.filter,
        items: FILTERS,
        onChange: (value) => {
          this.filter = value
          this.renderFilter()
          void this.load()
        },
      }),
    )
  }

  /** 打开并加载日志。 */
  open(): void {
    this.element.hidden = false
    document.body.style.overflow = 'hidden'
    this.keyword = ''
    this.filter = ''
    this.searchInput.value = ''
    this.renderFilter()
    this.removeEscListener = onEscape(() => this.close())
    void this.load()
  }

  /** 关闭弹窗。 */
  close(): void {
    this.element.hidden = true
    document.body.style.overflow = ''
    this.removeEscListener?.()
    this.removeEscListener = null
  }

  /** 加载日志。 */
  private async load(): Promise<void> {
    if (this.loading) return
    this.loading = true
    this.errorBox.hidden = true
    this.refreshButton.disabled = true
    replaceChildren(this.refreshButton, iconSvg(icons.spinner, 18, 'spin'))

    if (this.logs.length === 0) {
      replaceChildren(
        this.listHost,
        el(
          'div',
          { class: 'subtle-empty' },
          iconSvg(icons.spinner, 28, 'spin'),
          el('span', { text: '加载中…' }),
        ),
      )
    }

    try {
      this.logs = await api.logs(200, { action: this.filter || undefined })
      this.renderList()
    } catch (error) {
      this.errorBox.hidden = false
      this.errorBox.textContent =
        error instanceof ApiError ? error.message : '加载日志失败'
    } finally {
      this.loading = false
      this.refreshButton.disabled = false
      replaceChildren(this.refreshButton, iconSvg(icons.refresh, 18))
    }
  }

  /** 渲染列表（含关键词过滤）。 */
  private renderList(): void {
    const keyword = this.keyword.trim().toLowerCase()
    const filtered = keyword
      ? this.logs.filter((log) => {
          const haystack =
            `${log.action_type} ${log.account_name ?? ''} ${log.instance_id ?? ''} ${log.detail}`.toLowerCase()
          return haystack.includes(keyword)
        })
      : this.logs

    if (filtered.length === 0) {
      replaceChildren(
        this.listHost,
        el(
          'div',
          { class: 'subtle-empty' },
          iconSvg(icons.activity, 28),
          el('span', { text: this.logs.length === 0 ? '暂无日志' : '没有匹配的日志' }),
        ),
      )
      return
    }

    replaceChildren(
      this.listHost,
      ...filtered.map((log) =>
        el(
          'article',
          { class: 'log-row' },
          el('i', { class: `log-dot ${dotClass(log.action_type)}` }),
          el(
            'div',
            {},
            el('p', { text: log.detail }),
            el('span', {
              text: [
                ACTION_LABELS[log.action_type] ?? log.action_type,
                log.account_name,
                log.instance_id,
                formatTime(log.created_at),
              ]
                .filter(Boolean)
                .join(' · '),
            }),
          ),
        ),
      ),
    )
  }
}
