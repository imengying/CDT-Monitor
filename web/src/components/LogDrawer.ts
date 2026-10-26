/**
 * 日志抽屉（对应原版 `LogDrawer.vue`）
 * ============================================================================
 * 从右侧滑出的操作日志面板，展示 action_logs（自动化动作 + 告警 + 登录审计）。
 *
 * 配色规则：
 *   熔断 / 失败 / 拦截 -> 红
 *   通知 / 日报        -> 绿
 *   定时 / 保活 / 手动 -> 蓝
 *   其它（审计等）      -> 灰
 */

import { api, ApiError, formatTime, type ActionLog } from '@/api/client'
import { el, iconSvg, onEscape, replaceChildren } from '@/lib/dom'
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

type Tone = 'danger' | 'brand' | 'ok' | 'muted'

/** 日志分类配色。 */
function toneOf(actionType: string): Tone {
  if (
    actionType.includes('failed') ||
    actionType.includes('threshold') ||
    actionType.includes('blocked') ||
    actionType.includes('login_failed') ||
    actionType.includes('turnstile_failed')
  ) {
    return 'danger'
  }
  if (actionType.startsWith('notify') || actionType.includes('report')) return 'ok'
  if (
    actionType.includes('manual') ||
    actionType.includes('schedule') ||
    actionType.includes('keep_alive') ||
    actionType.includes('refresh')
  ) {
    return 'brand'
  }
  return 'muted'
}

/** 日志抽屉控制器。 */
export class LogDrawer {
  readonly element: HTMLDivElement

  private readonly listHost: HTMLDivElement
  private readonly countBadge: HTMLSpanElement
  private readonly searchInput: HTMLInputElement
  private readonly errorBox: HTMLDivElement
  private readonly refreshButton: HTMLButtonElement

  private logs: ActionLog[] = []
  private filter = ''
  private actionFilter = ''
  private readonly actionSelect: HTMLSelectElement
  private loading = false
  private removeEscListener: (() => void) | null = null

  constructor() {
    this.listHost = el('div', { class: 'scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-3' })
    this.countBadge = el('span', { class: 'badge badge-muted', text: '0' })
    this.errorBox = el('div', {
      class: 'mx-4 mt-3 hidden rounded-lg px-3 py-2 text-xs',
      style: {
        backgroundColor: 'var(--color-danger-soft)',
        color: 'var(--color-danger)',
      },
    })

    this.searchInput = el('input', {
      class: 'input',
      type: 'search',
      placeholder: '按账号、实例、类型或内容筛选…',
    }) as HTMLInputElement
    this.searchInput.addEventListener('input', () => {
      this.filter = this.searchInput.value
      this.renderList()
    })

    this.actionSelect = el('select', { class: 'input py-1 text-xs' }) as HTMLSelectElement
    for (const [value, label] of [
      ['', '全部类型'],
      ['login', '登录'],
      ['threshold', '熔断'],
      ['manual', '手动操作'],
      ['batch', '批量操作'],
      ['schedule', '定时开关机'],
      ['spot', '保活'],
      ['refresh', '采集'],
      ['settings', '设置变更'],
      ['notify', '通知'],
      ['session', '设备'],
      ['daily_report', '日报'],
    ]) {
      this.actionSelect.append(
        el('option', { value, text: label }) as HTMLOptionElement,
      )
    }
    this.actionSelect.addEventListener('change', () => {
      this.actionFilter = this.actionSelect.value
      void this.load()
    })

    this.refreshButton = el('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      'aria-label': '刷新日志',
      on: { click: () => void this.load() },
    }) as HTMLButtonElement
    replaceChildren(this.refreshButton, iconSvg(icons.refresh, 13))

    this.element = el(
      'div',
      {
        class: 'fixed inset-0 z-50 hidden justify-end',
        on: {
          click: (event) => {
            if (event.target === this.element) this.close()
          },
        },
      },
      el('div', {
        class: 'absolute inset-0',
        style: { backgroundColor: 'rgb(0 0 0 / 0.38)' },
        on: { click: () => this.close() },
      }),
      el(
        'aside',
        {
          class: 'relative flex h-full w-full max-w-xl flex-col border-l shadow-2xl',
          style: { backgroundColor: 'var(--color-surface)', borderColor: 'var(--color-line)' },
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': '操作日志',
        },
        el(
          'header',
          {
            class: 'flex items-center justify-between gap-2 border-b px-4 py-3',
            style: { borderColor: 'var(--color-line)' },
          },
          el(
            'div',
            { class: 'flex items-center gap-2' },
            iconSvg(icons.activity, 15),
            el('h2', { class: 'text-sm font-semibold', text: '操作日志' }),
            this.countBadge,
          ),
          el(
            'div',
            { class: 'flex items-center gap-1.5' },
            this.refreshButton,
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
        el(
          'div',
          {
            class: 'flex items-center gap-2 border-b px-4 py-2',
            style: { borderColor: 'var(--color-line)' },
          },
          this.actionSelect,
          this.searchInput,
        ),
        this.errorBox,
        this.listHost,
      ),
    )
  }

  /** 打开抽屉并加载日志。 */
  open(): void {
    document.body.style.overflow = 'hidden'
    this.element.classList.remove('hidden')
    this.element.style.display = 'flex'
    this.filter = ''
    this.actionFilter = ''
    this.actionSelect.value = ''
    this.searchInput.value = ''
    this.removeEscListener = onEscape(() => this.close())
    void this.load()
  }

  /** 关闭抽屉。 */
  close(): void {
    this.element.classList.add('hidden')
    this.element.style.display = 'none'
    document.body.style.overflow = ''
    this.removeEscListener?.()
    this.removeEscListener = null
  }

  /** 加载日志。 */
  private async load(): Promise<void> {
    if (this.loading) return
    this.loading = true
    this.errorBox.classList.add('hidden')
    this.refreshButton.disabled = true
    replaceChildren(this.refreshButton, iconSvg(icons.spinner, 13, 'animate-spin'))

    if (this.logs.length === 0) {
      this.renderSkeleton()
    }

    try {
      this.logs = await api.logs(200, { action: this.actionFilter || undefined })
      this.renderList()
    } catch (error) {
      this.errorBox.classList.remove('hidden')
      this.errorBox.textContent =
        error instanceof ApiError ? error.message : '加载日志失败'
    } finally {
      this.loading = false
      this.refreshButton.disabled = false
      replaceChildren(this.refreshButton, iconSvg(icons.refresh, 13))
    }
  }

  private renderSkeleton(): void {
    const items: HTMLElement[] = []
    for (let index = 0; index < 6; index += 1) {
      items.push(el('div', { class: 'skeleton h-14 w-full' }))
    }
    replaceChildren(this.listHost, el('div', { class: 'space-y-2' }, ...items))
  }

  /** 渲染列表（含筛选）。 */
  private renderList(): void {
    const keyword = this.filter.trim().toLowerCase()
    const filtered = keyword
      ? this.logs.filter((log) => {
          const haystack =
            `${log.action_type} ${log.account_name ?? ''} ${log.instance_id ?? ''} ${log.detail}`.toLowerCase()
          return haystack.includes(keyword)
        })
      : this.logs

    this.countBadge.textContent = String(filtered.length)

    if (filtered.length === 0) {
      replaceChildren(
        this.listHost,
        el(
          'div',
          {
            class: 'flex h-full flex-col items-center justify-center gap-1.5 text-xs',
            style: { color: 'var(--color-ink-subtle)' },
          },
          iconSvg(icons.activity, 20),
          el('span', {
            text: this.logs.length === 0 ? '暂无日志' : '没有匹配的日志',
          }),
        ),
      )
      return
    }

    const list = el('ul', { class: 'space-y-2' })
    for (const log of filtered) {
      const tone = toneOf(log.action_type)
      const palette =
        tone === 'danger'
          ? { background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }
          : tone === 'brand'
            ? { background: 'var(--color-brand-soft)', color: 'var(--color-brand)' }
            : tone === 'ok'
              ? { background: 'var(--color-ok-soft)', color: 'var(--color-ok)' }
              : { background: 'var(--color-surface-muted)', color: 'var(--color-ink-muted)' }

      const head = el(
        'div',
        { class: 'flex flex-wrap items-center gap-1.5' },
        el('span', {
          class: 'badge',
          style: palette,
          text: ACTION_LABELS[log.action_type] ?? log.action_type,
        }),
        ...(log.account_name
          ? [el('span', { class: 'text-[0.8125rem] font-medium', text: log.account_name })]
          : []),
        ...(log.instance_id
          ? [
              el('span', {
                class: 'font-mono text-xs',
                style: { color: 'var(--color-ink-subtle)' },
                text: log.instance_id,
              }),
            ]
          : []),
        el('span', {
          class: 'ml-auto text-xs tabular-nums',
          style: { color: 'var(--color-ink-subtle)' },
          text: formatTime(log.created_at),
        }),
      )

      list.append(
        el(
          'li',
          {
            class: 'rounded-lg border px-3 py-2',
            style: { borderColor: 'var(--color-line)' },
          },
          head,
          el('p', {
            class: 'mt-1 text-[0.8125rem] leading-relaxed break-words',
            style: { color: 'var(--color-ink-muted)' },
            text: log.detail,
          }),
        ),
      )
    }

    replaceChildren(this.listHost, list)
  }
}
