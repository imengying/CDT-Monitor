/**
 * 账号卡片
 * ============================================================================
 * 结构照搬上游 `AccountCard`：
 *
 *   ┌ 头部：状态图标 · 名称/地域 · 状态胶囊/余额 ┐
 *   ├ 流量：大号数字 + 历史按钮 · 进度条 · 百分比/阈值 ┤
 *   └ 底部：最近同步时间 · 设置/刷新/开机/关机         ┘
 *
 * 按钮的执行态由 `busy` 集合驱动：提交后立即禁用并显示 spinner，
 * 直到接口返回，避免连点触发服务端 409。
 */

import { api, humanAmount, relativeTime, type AccountOverview, type InstanceInfo } from '@/api/client'
import { el, iconSvg, iconButton, replaceChildren } from '@/lib/dom'
import { icons, type IconNode } from '@/lib/icons'
import { afterAccountChanged, reportError } from '@/lib/actions'
import { toast } from '@/lib/store'

/** 实例状态 → 视觉色调。 */
function statusTone(status: string, enabled: boolean): string {
  if (!enabled) return 'negative'
  if (status === 'running') return 'positive'
  if (status === 'stopped') return 'negative'
  if (!status) return 'neutral'
  return 'warning'
}

/** 实例状态中文名。 */
function statusLabel(status: string): string {
  const map: Record<string, string> = {
    running: '运行中',
    stopped: '已停止',
    starting: '启动中',
    stopping: '停止中',
    pending: '等待中',
  }
  return map[status] ?? (status ? '未知' : '无实例')
}

/**
 * 计算账号数据的渲染指纹。
 *
 * 排除 `snapshot_updated_at`（采集时间戳，不代表可见内容变化）。
 */
function signatureOf(account: AccountOverview): string {
  return JSON.stringify({
    id: account.id,
    name: account.name,
    site: account.site_label,
    region: account.region_name,
    threshold: account.traffic_threshold_gb,
    quota: account.quota_gb,
    stopMode: account.stop_mode,
    spot: account.spot_keep_alive,
    enabled: account.enabled,
    balance: account.balance_amount,
    currency: account.balance_currency,
    cash: account.balance_cash,
    credit: account.balance_credit,
    used: account.traffic_used_gb,
    percent: account.percentage,
    triggered: account.threshold_triggered,
    instances: account.instances.map((instance) => ({
      id: instance.instance_id,
      status: instance.status,
      keep: instance.keep_alive,
    })),
  })
}

/** 账号卡片。 */
export class AccountCard {
  private root: HTMLElement
  private account: AccountOverview
  private signature = ''

  /** 正在执行中的操作键：`refresh` / `start` / `stop` / `keepalive`。 */
  private readonly busy = new Set<string>()

  constructor(
    account: AccountOverview,
    private readonly onEdit?: (accountId: number) => void,
    private readonly onHistory?: (account: AccountOverview) => void,
  ) {
    this.account = account
    this.signature = signatureOf(account)
    this.root = this.build()
  }

  get element(): HTMLElement {
    return this.root
  }

  /**
   * 用新数据更新。
   *
   * 只有真正变化时才重建 DOM：静默轮询的数据经常一模一样，
   * 无条件重建会让正在聚焦的按钮丢焦点、重置滚动位置。
   */
  update(account: AccountOverview): void {
    const next = signatureOf(account)
    if (next === this.signature) {
      this.account = account
      this.refreshRelativeTime(account)
      return
    }
    const previous = this.root
    this.account = account
    this.signature = next
    this.root = this.build()
    previous.replaceWith(this.root)
  }

  /** 刷新「同步于 …」文本（不重建 DOM）。 */
  private refreshRelativeTime(account: AccountOverview): void {
    const node = this.root.querySelector<HTMLElement>('[data-role="updated-at"]')
    if (!node) return
    node.textContent = account.snapshot_updated_at
      ? relativeTime(account.snapshot_updated_at)
      : '等待首次同步'
  }

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  private build(): HTMLElement {
    const account = this.account
    return el(
      'article',
      {
        class: `glass-card account-card${account.threshold_triggered ? ' account-card--alert' : ''}`,
      },
      this.buildHeader(),
      this.buildTrafficBlock(),
      this.buildFooter(),
    )
  }

  /** 头部：状态图标 + 名称/地域 + 状态胶囊 + 余额与额度。 */
  private buildHeader(): HTMLElement {
    const account = this.account
    const primary = account.instances[0]
    const status = primary?.status.toLowerCase() ?? ''
    const tone = statusTone(status, account.enabled)
    const text = account.enabled ? statusLabel(status) : '已停用'

    const billing = el('div', { class: 'account-billing' })

    if (account.balance_amount !== null) {
      const breakdown = this.balanceBreakdown()
      billing.append(
        el(
          'div',
          {},
          el('span', { text: '账户余额' }),
          el('b', {
            text: humanAmount(account.balance_amount, account.balance_currency),
            title: breakdown,
          }),
        ),
      )
    }

    billing.append(
      el(
        'div',
        {},
        el('span', { text: '本月额度' }),
        el('b', { text: `${account.quota_gb.toFixed(0)} GB` }),
      ),
      // 站点类型放说明行：与余额/额度并排会把三列挤成一团
      el('small', { text: account.site_label }),
    )

    return el(
      'header',
      { class: 'account-card__header' },
      el('div', { class: `status-icon ${tone}` }, iconSvg(icons.server, 20)),
      el(
        'div',
        { class: 'account-title' },
        el('h3', { text: account.name, title: account.name }),
        el('span', { text: account.region_name }),
      ),
      el(
        'div',
        { class: 'account-card__side' },
        el('div', { class: `status-pill ${tone}` }, el('i', {}), el('span', { text })),
        billing,
      ),
    )
  }

  /** 余额分项的悬浮文案。 */
  private balanceBreakdown(): string {
    const account = this.account
    const parts: string[] = []
    if (account.balance_cash !== null) {
      parts.push(`现金 ${humanAmount(account.balance_cash, account.balance_currency)}`)
    }
    if (account.balance_credit !== null && account.balance_credit > 0) {
      parts.push(`信用 ${humanAmount(account.balance_credit, account.balance_currency)}`)
    }
    return parts.join(' · ')
  }

  /** 流量区：大号数字 + 进度条 + 百分比与阈值。 */
  private buildTrafficBlock(): HTMLElement {
    const account = this.account
    const percent = account.percentage
    const fill = account.threshold_triggered
      ? 'danger'
      : percent >= 80
        ? 'warning'
        : ''

    const historyButton = el(
      'button',
      {
        class: 'mini-icon',
        type: 'button',
        'aria-label': '查看历史流量',
        title: '历史流量',
        on: { click: () => this.onHistory?.(this.account) },
      },
      iconSvg(icons.chart, 17),
    )

    const refreshButton = this.actionButton({
      key: 'refresh',
      label: '刷新实例',
      icon: icons.refresh,
      mini: true,
      onClick: () => void this.refreshAccount(),
    })

    return el(
      'div',
      {},
      el(
        'div',
        { class: 'traffic-value' },
        el(
          'div',
          {},
          el('span', { text: '本月 CDT 流量' }),
          el('strong', { text: account.traffic_used_gb.toFixed(2) }),
          el('small', { text: ` / ${account.quota_gb.toFixed(0)} GB` }),
        ),
        el('div', { class: 'control-group' }, historyButton, refreshButton),
      ),
      el(
        'div',
        { class: 'progress-track' },
        el('i', {
          class: fill,
          style: { width: `${Math.min(Math.max(percent, 0), 100)}%` },
        }),
      ),
      el(
        'div',
        { class: 'progress-meta' },
        el('span', { text: `${percent.toFixed(2)}% 已使用` }),
        el('span', {
          text:
            account.traffic_threshold_gb > 0
              ? `阈值 ${account.traffic_threshold_gb} GB`
              : '未设阈值',
        }),
      ),
    )
  }

  /** 底部：同步时间 + 操作按钮组。 */
  private buildFooter(): HTMLElement {
    const account = this.account
    const primary = account.instances[0]
    const status = primary?.status.toLowerCase() ?? ''
    const running = status === 'running'
    const stopped = status === 'stopped'

    const group = el('div', { class: 'control-group' })

    group.append(
      iconButton({
        label: '实例设置',
        icon: icons.settings,
        onClick: () => this.onEdit?.(this.account.id),
      }),
    )

    if (primary) {
      group.append(
        this.actionButton({
          key: 'refresh',
          label: '强制刷新实例状态',
          icon: icons.refresh,
          onClick: () => void this.refreshAccount(),
        }),
      )

      if (stopped) {
        group.append(
          this.actionButton({
            key: 'start',
            label: '开机',
            icon: icons.play,
            tone: 'positive',
            onClick: () => void this.toggleInstance(primary, true),
          }),
        )
      }

      if (running) {
        const keepAlive = account.spot_keep_alive
        group.append(
          this.actionButton({
            key: 'stop',
            label: keepAlive ? '保活启用，不能关机' : '关机',
            icon: icons.power,
            tone: 'danger',
            disabled: keepAlive,
            onClick: () => void this.toggleInstance(primary, false),
          }),
        )
      }
    }

    return el(
      'footer',
      { class: 'account-card__footer' },
      el(
        'span',
        {},
        iconSvg(icons.calendar, 14),
        el('span', {
          dataset: { role: 'updated-at' },
          text: account.snapshot_updated_at
            ? relativeTime(account.snapshot_updated_at)
            : '等待首次同步',
        }),
      ),
      group,
    )
  }

  // -------------------------------------------------------------------------
  // 按钮
  // -------------------------------------------------------------------------

  private actionButton(options: {
    key: string
    label: string
    icon: IconNode
    onClick: () => void
    tone?: 'positive' | 'danger'
    disabled?: boolean
    mini?: boolean
  }): HTMLButtonElement {
    const button = el('button', {
      class: options.mini ? 'mini-icon' : 'icon-button',
      type: 'button',
      'aria-label': options.label,
      title: options.label,
      'data-action': options.key,
    }) as HTMLButtonElement

    if (!options.mini && options.tone) {
      button.classList.add(`icon-button--${options.tone}`)
    }

    button.disabled = Boolean(options.disabled)
    button.append(iconSvg(options.icon, options.mini ? 17 : 18))
    button.addEventListener('click', () => {
      if (button.disabled) return
      options.onClick()
    })
    return button
  }

  /** 设置按钮忙碌态（不重建整张卡片）。 */
  private markBusy(key: string, active: boolean, node?: HTMLButtonElement): void {
    if (active) this.busy.add(key)
    else this.busy.delete(key)

    // 同一个动作可能出现在多个位置（流量区的小按钮 + 底部操作组），逐个同步
    const buttons = node
      ? [node]
      : [...this.root.querySelectorAll<HTMLButtonElement>(`[data-action="${key}"]`)]

    for (const button of buttons) {
      if (active) {
        replaceChildren(button, iconSvg(icons.spinner, button.classList.contains('mini-icon') ? 17 : 18, 'spin'))
        button.disabled = true
      } else {
        button.disabled = false
        replaceChildren(
          button,
          iconSvg(this.iconOf(key), button.classList.contains('mini-icon') ? 17 : 18),
        )
      }
    }
  }

  /** 忙碌态结束后要还原的图标。 */
  private iconOf(key: string): IconNode {
    const map: Record<string, IconNode> = {
      refresh: icons.refresh,
      start: icons.play,
      stop: icons.power,
    }
    return map[key] ?? icons.refresh
  }

  // -------------------------------------------------------------------------
  // 动作
  // -------------------------------------------------------------------------

  private async refreshAccount(): Promise<void> {
    if (this.busy.has('refresh')) return
    this.markBusy('refresh', true)
    try {
      await api.refreshAccount(this.account.id)
      toast('实例状态已刷新', 'ok')
      await afterAccountChanged()
    } catch (error) {
      reportError(error, '刷新失败')
    } finally {
      this.markBusy('refresh', false)
    }
  }

  private async toggleInstance(instance: InstanceInfo, start: boolean): Promise<void> {
    if (this.busy.has(start ? 'start' : 'stop')) return
    this.markBusy(start ? 'start' : 'stop', true)
    try {
      if (start) {
        await api.startInstance(this.account.id, instance.instance_id)
      } else {
        await api.stopInstance(this.account.id, instance.instance_id)
      }
      toast(start ? '已发送开机指令' : '已发送关机指令', 'ok')
      await afterAccountChanged()
    } catch (error) {
      reportError(error, start ? '开机失败' : '关机失败')
    } finally {
      this.markBusy(start ? 'start' : 'stop', false)
    }
  }
}

/** 账号卡片列表容器（负责增量更新）。 */
export class AccountList {
  readonly element: HTMLElement

  private readonly cards = new Map<number, AccountCard>()

  constructor(
    private readonly onEdit?: (accountId: number) => void,
    private readonly onHistory?: (account: AccountOverview) => void,
  ) {
    this.element = el('section', { class: 'account-grid' })
  }

  /** 同步账号列表。 */
  render(accounts: AccountOverview[]): void {
    const seen = new Set<number>()

    for (const account of accounts) {
      seen.add(account.id)
      const existing = this.cards.get(account.id)
      if (existing) {
        existing.update(account)
      } else {
        const card = new AccountCard(account, this.onEdit, this.onHistory)
        this.cards.set(account.id, card)
        this.element.append(card.element)
      }
    }

    for (const [id, card] of [...this.cards]) {
      if (!seen.has(id)) {
        card.element.remove()
        this.cards.delete(id)
      }
    }
  }

  get size(): number {
    return this.cards.size
  }
}
