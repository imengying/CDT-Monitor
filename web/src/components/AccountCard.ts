/**
 * 账号卡片（对应原版 `AccountCard.vue`）
 * ============================================================================
 * 一张卡片对应一个阿里云账号：
 *   头部：名称 + 站点 + AK 掩码 + 状态徽章 + 刷新按钮
 *   数据：余额 / 策略标签 + 国内/海外/合计三条进度条
 *   实例：每个实例一行，含状态徽章、规格/IP、保活开关、开机/关机
 *
 * 按钮的执行态由 `busy` 集合驱动：提交后立即禁用并显示 spinner，
 * 直到 Job 轮询结束（或失败），避免连点触发服务端 409。
 */

import {
  api,
  humanAmount,
  humanBytes,
  relativeTime,
  type AccountOverview,
  type InstanceInfo,
} from '@/api/client'
import { el, iconSvg, replaceChildren } from '@/lib/dom'
import { icons, type IconNode } from '@/lib/icons'
import { afterAccountChanged, reportError } from '@/lib/actions'
import { toast } from '@/lib/store'

/** 实例状态 -> 徽章配色。 */
function instanceTone(status: string): 'ok' | 'warn' | 'danger' | 'muted' {
  const lower = status.toLowerCase()
  if (lower === 'running') return 'ok'
  if (lower === 'stopped') return 'muted'
  if (lower.startsWith('start') || lower.startsWith('stop') || lower === 'pending') return 'warn'
  return 'danger'
}

/** 实例状态中文名。 */
function instanceStatusLabel(status: string): string {
  const map: Record<string, string> = {
    Running: '运行中',
    Stopped: '已停止',
    Starting: '启动中',
    Stopping: '停止中',
    Pending: '创建中',
  }
  return map[status] ?? status ?? '未知'
}

/**
 * 计算账号数据的渲染指纹。
 *
 * 排除 `snapshot_updated_at`（采集时间戳，不代表可见内容变化）。
 * 用 JSON 序列化就够：字段都是原始类型与数组，顺序稳定。
 */
function signatureOf(account: AccountOverview): string {
  return JSON.stringify({
    id: account.id,
    name: account.name,
    site_label: account.site_label,
    ak: account.access_key_id_masked,
    limit: account.traffic_limit_gb,
    action: account.over_limit_action,
    actionLabel: account.over_limit_action_label,
    stopMode: account.stop_mode,
    stopModeLabel: account.stop_mode_label,
    start: account.schedule_start_time,
    stop: account.schedule_stop_time,
    spot: account.spot_keep_alive,
    enabled: account.enabled,
    balance: account.balance_amount,
    currency: account.balance_currency,
    domestic: account.cdt_domestic_bytes,
    overseas: account.cdt_overseas_bytes,
    total: account.cdt_total_bytes,
    month: account.billing_month,
    triggered: account.threshold_triggered,
    forecast: account.forecast
      ? `${account.forecast.projected_bytes}:${account.forecast.exceed_date ?? ''}`
      : '',
    instances: account.instances.map((instance) => ({
      id: instance.instance_id,
      name: instance.instance_name,
      type: instance.instance_type,
      region: instance.region_id,
      status: instance.status,
      pub: instance.public_ip,
      priv: instance.private_ip,
      charge: instance.instance_charge_type,
      spot: instance.spot,
      keep: instance.keep_alive,
    })),
  })
}

/** 小圆点。 */
function dot(color: string): HTMLSpanElement {
  return el('span', {
    class: 'h-1.5 w-1.5 rounded-full',
    style: { backgroundColor: color },
  })
}

/** 按钮描述。 */
interface ActionSpec {
  key: string
  label: string
  icon: IconNode
  className: string
  /** 仅图标按钮时的悬浮提示。 */
  title?: string
  disabled?: boolean
  onClick: () => Promise<void> | void
}

/** 账号卡片。 */
export class AccountCard {
  private root: HTMLElement
  private account: AccountOverview
  /** 已渲染数据的指纹，用于跳过无变化的重建。 */
  private signature = ''

  /** 正在执行中的操作键：`refresh` 或 `${instanceId}:${action}`。 */
  private readonly busy = new Set<string>()
  /** 逐实例保活的即时覆盖值（避免等整页刷新）。 */
  private readonly keepAliveOverride = new Map<string, boolean>()
  /** 已注册的按钮，用于就地刷新状态（不重建 DOM）。 */
  private buttons: { spec: ActionSpec; node: HTMLButtonElement }[] = []

  constructor(
    account: AccountOverview,
    private readonly onEdit?: (accountId: number) => void,
  ) {
    this.account = account
    this.signature = signatureOf(account)
    this.root = this.build()
  }

  /** 当前 DOM 节点。 */
  get element(): HTMLElement {
    return this.root
  }

  /**
   * 用新数据更新。
   *
   * 只有**真正变化**时才重建 DOM。60 秒一次的静默轮询在数据没变时
   * 会带着完全相同的对象进来，若无条件 `rebuild()` 会：
   * * 让正在聚焦的按钮丢焦点（键盘用户无法连续操作）
   * * 重置滚动位置（长实例列表里尤其恼人）
   * * 白白丢弃一遍 DOM 与事件监听
   *
   * `snapshot_updated_at` 不参与比较：它是采集时间戳，只要真实数据
   * 没变就不值得为它重建整张卡片。
   */
  update(account: AccountOverview): void {
    const nextSignature = signatureOf(account)
    if (nextSignature === this.signature) {
      // 数据没变，只刷新一下「更新于 x 分钟前」这类相对时间文本
      this.account = account
      this.refreshRelativeTime(account)
      return
    }
    this.account = account
    this.signature = nextSignature
    this.rebuild()
  }

  /** 刷新「更新于 …」文本（不重建 DOM）。 */
  private refreshRelativeTime(account: AccountOverview): void {
    const node = this.root.querySelector<HTMLElement>('[data-role="updated-at"]')
    if (!node) return
    node.textContent = account.snapshot_updated_at
      ? `更新于 ${relativeTime(account.snapshot_updated_at)}`
      : '尚未采集'
  }

  /** 重建 DOM 并保持节点位置。 */
  private rebuild(): void {
    const previous = this.root
    this.signature = signatureOf(this.account)
    this.root = this.build()
    previous.replaceWith(this.root)
  }

  /** 只刷新按钮的忙碌态（不重建整张卡片，保留滚动位置与焦点）。 */
  private syncButtons(): void {
    for (const { spec, node } of this.buttons) {
      const busy = this.busy.has(spec.key)
      node.disabled = busy || Boolean(spec.disabled)
      replaceChildren(
        node,
        ...(busy
          ? [iconSvg(icons.spinner, 12, 'animate-spin'), el('span', { text: spec.label })]
          : [iconSvg(spec.icon, 12), el('span', { text: spec.label })]),
      )
    }
  }

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  private build(): HTMLElement {
    this.buttons = []
    return el(
      'article',
      {
        class: 'card card-hover',
        style: { padding: '21px 22px', animation: 'stage-in .7s var(--ease-out) both' },
      },
      this.buildHeader(),
      this.buildTrafficBlock(),
      this.buildFooterRow(),
      ...(this.account.threshold_triggered ? [this.buildThresholdBanner()] : []),
      this.buildInstanceSection(),
    )
  }

  /** 卡片头部：状态图标 + 名称/地域 + 状态胶囊 + 费用与余额。 */
  private buildHeader(): HTMLElement {
    const account = this.account
    // 主实例（单实例部署时即唯一实例）
    const primary = account.instances[0]
    const status = primary?.status.toLowerCase() ?? ''
    const tone =
      !account.enabled ? 'negative' : status === 'running' ? 'positive' : status === 'stopped' ? 'negative' : 'warning'
    const toneColor =
      tone === 'positive'
        ? 'var(--color-ok)'
        : tone === 'negative'
          ? 'var(--color-ink-subtle)'
          : 'var(--color-warn)'
    const toneBg =
      tone === 'positive'
        ? 'var(--color-ok-soft)'
        : tone === 'negative'
          ? 'var(--color-surface-muted)'
          : 'var(--color-warn-soft)'

    const statusText = !account.enabled
      ? '已停用'
      : primary
        ? instanceStatusLabel(primary.status)
        : '无实例'

    return el(
      'header',
      {
        class: 'grid items-start gap-3.5',
        style: { gridTemplateColumns: '46px minmax(0, 1fr) auto' },
      },
      el(
        'div',
        {
          class: 'grid place-items-center rounded-xl',
          style: {
            width: '46px',
            height: '46px',
            color: toneColor,
            backgroundColor: toneBg,
            boxShadow: 'inset 0 1px 0 var(--color-inner-line)',
          },
        },
        iconSvg(icons.server, 20),
      ),
      el(
        'div',
        { class: 'min-w-0' },
        el(
          'h3',
          {
            class: 'truncate text-base leading-tight font-semibold',
            text: account.name,
          },
        ),
        el('span', {
          class: 'mt-1 block truncate text-xs',
          style: { color: 'var(--color-ink-subtle)' },
          text: primary?.region_id || account.site_label,
        }),
      ),
      el(
        'div',
        { class: 'flex flex-col items-end gap-2' },
        el(
          'div',
          {
            class: 'inline-flex items-center gap-1.5 rounded-full px-2.5 text-xs font-bold',
            style: {
              height: '30px',
              color: toneColor,
              backgroundColor: toneBg,
            },
          },
          el('i', {
            class: 'block h-1.5 w-1.5 rounded-full',
            style: { backgroundColor: toneColor },
          }),
          el('span', { text: statusText }),
        ),
        el(
          'div',
          {
            class: 'grid justify-end gap-x-4 gap-y-0.5 text-right',
            style: { gridTemplateColumns: 'auto auto' },
          },
          el(
            'div',
            { class: 'grid gap-0.5' },
            el('span', {
              class: 'text-[10px] font-bold',
              style: { color: 'var(--color-ink-subtle)' },
              text: '账户余额',
            }),
            el('b', {
              class: 'font-mono text-xs tabular-nums',
              text: humanAmount(account.balance_amount, account.balance_currency),
            }),
          ),
          el(
            'div',
            { class: 'grid gap-0.5' },
            el('span', {
              class: 'text-[10px] font-bold',
              style: { color: 'var(--color-ink-subtle)' },
              text: '阈值',
            }),
            el('b', {
              class: 'font-mono text-xs tabular-nums',
              text: `${account.traffic_limit_gb} GB`,
            }),
          ),
        ),
      ),
    )
  }

  /** 流量区：大号数字 + 单条进度 + 百分比与账期。 */
  private buildTrafficBlock(): HTMLElement {
    const account = this.account
    const percent = account.total_percent
    const fill =
      account.threshold_triggered || percent >= 100
        ? 'var(--color-danger)'
        : percent >= 80
          ? 'var(--color-warn)'
          : 'var(--color-ink)'

    return el(
      'div',
      {},
      el(
        'div',
        {
          class: 'mt-5 flex items-end justify-between',
        },
        el(
          'div',
          {},
          el('span', {
            class: 'mb-1 block text-[10px] font-bold',
            style: { color: 'var(--color-ink-subtle)' },
            text: '本月 CDT 流量',
          }),
          el(
            'div',
            { class: 'flex items-baseline gap-1' },
            el('strong', {
              class: 'text-3xl font-bold tabular-nums',
              text: (account.cdt_total_bytes / 1024 ** 3).toFixed(2),
            }),
            el('small', {
              class: 'font-bold tabular-nums',
              style: { color: 'var(--color-ink-subtle)' },
              text: `/ ${account.traffic_limit_gb.toFixed(0)} GB`,
            }),
          ),
        ),
        this.actionButton({
          key: 'refresh',
          label: '',
          icon: icons.refresh,
          className: 'btn-ghost',
          title: '刷新',
          onClick: () => this.refreshAccount(),
        }),
      ),
      el(
        'div',
        {
          class: 'mt-3 overflow-hidden rounded-full',
          style: {
            height: '7px',
            backgroundColor: 'color-mix(in oklab, var(--color-line-strong) 68%, transparent)',
            boxShadow: 'inset 0 1px 3px rgb(0 0 0 / 0.08)',
          },
        },
        el('i', {
          class: 'block h-full rounded-full',
          style: {
            width: `${Math.min(Math.max(percent, 0), 100)}%`,
            backgroundColor: fill,
            animation: 'progress-in .8s .35s var(--ease-emphasis) both',
          },
        }),
      ),
      el(
        'div',
        {
          class: 'mt-2 flex justify-between text-[10px] font-bold tabular-nums',
          style: { color: 'var(--color-ink-muted)' },
        },
        el('span', { text: `${percent.toFixed(2)}% 已使用` }),
        el('span', { text: `账期 ${account.billing_month || '—'}` }),
      ),
      el(
        'div',
        {
          class: 'mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs',
          style: { color: 'var(--color-ink-subtle)' },
        },
        el('span', { text: `国内 ${humanBytes(account.cdt_domestic_bytes)}` }),
        el('span', { text: `非内地 ${humanBytes(account.cdt_overseas_bytes)}` }),
        ...(account.forecast
          ? [
              el('span', {
                style:
                  account.forecast.exceed_date !== null
                    ? { color: 'var(--color-warn)', fontWeight: '600' }
                    : {},
                text: `预计月末 ${(account.forecast.projected_bytes / 1024 ** 3).toFixed(1)} GB`,
              }),
            ]
          : []),
      ),
    )
  }

  /** 底部：更新时间 + 操作按钮组。 */
  private buildFooterRow(): HTMLElement {
    const account = this.account
    const primary = account.instances[0]
    const running = primary?.status.toLowerCase() === 'running'
    const stopped = primary?.status.toLowerCase() === 'stopped'

    const buttons: HTMLElement[] = [
      this.actionButton({
        key: 'settings',
        label: '',
        icon: icons.settings,
        className: 'btn-ghost',
        title: '账号设置',
        onClick: () => this.onEdit?.(this.account.id),
      }),
    ]
    if (stopped) {
      buttons.push(
        this.actionButton({
          key: 'start',
          label: '',
          icon: icons.play,
          className: 'btn-ghost',
          title: '开机',
          onClick: () => void this.toggleInstance(primary, true),
        }),
      )
    }
    if (running) {
      buttons.push(
        this.actionButton({
          key: 'stop',
          label: '',
          icon: icons.power,
          className: 'btn-danger',
          title: '关机',
          onClick: () => void this.toggleInstance(primary, false),
        }),
      )
    }

    return el(
      'footer',
      {
        class: 'mt-4 flex flex-wrap items-center justify-between gap-2 border-t pt-3.5',
        style: { borderColor: 'var(--color-line)' },
      },
      el(
        'span',
        {
          class: 'flex items-center gap-1.5 text-[10px] tabular-nums',
          style: { color: 'var(--color-ink-subtle)' },
        },
        iconSvg(icons.calendar, 14),
        el('span', {
          dataset: { role: 'updated-at' },
          text: account.snapshot_updated_at
            ? relativeTime(account.snapshot_updated_at)
            : '等待首次同步',
        }),
      ),
      el('div', { class: 'flex gap-2' }, ...buttons),
    )
  }

  private buildInstanceSection(): HTMLElement {
    const account = this.account
    const running = account.instances.filter((i) => i.status.toLowerCase() === 'running').length
    const stopped = account.instances.filter((i) => i.status.toLowerCase() === 'stopped').length

    const header = el(
      'div',
      { class: 'flex items-center justify-between px-5 py-2.5' },
      el(
        'div',
        { class: 'flex items-center gap-2' },
        iconSvg(icons.serverCog, 14),
        el('span', { class: 'text-xs font-semibold', text: '实例控制' }),
        el('span', { class: 'badge badge-muted', text: String(account.instances.length) }),
      ),
      account.instances.length === 0
        ? el('span')
        : el(
            'div',
            { class: 'flex items-center gap-3' },
            el(
              'div',
              {
                class: 'hidden items-center gap-2 text-[0.8125rem] sm:flex',
                style: { color: 'var(--color-ink-subtle)' },
              },
              el(
                'span',
                { class: 'inline-flex items-center gap-1' },
                dot('var(--color-ok)'),
                el('span', { text: `${running} 运行` }),
              ),
              el(
                'span',
                { class: 'inline-flex items-center gap-1' },
                dot('var(--color-ink-subtle)'),
                el('span', { text: `${stopped} 停止` }),
              ),
            ),
            el(
              'div',
              { class: 'flex items-center gap-1.5' },
              this.batchButton('全部开机', 'batch-start', true, running === account.instances.length),
              this.batchButton('全部关机', 'batch-stop', false, stopped === account.instances.length),
            ),
          ),
    )

    const body =
      account.instances.length === 0
        ? el('div', {
            class: 'px-5 pb-5 text-center text-[0.8125rem]',
            style: { color: 'var(--color-ink-subtle)' },
            text: '暂无实例数据。',
          })
        : el(
            'ul',
            { class: 'divide-y', style: { borderColor: 'var(--color-line)' } },
            ...account.instances.map((instance) => this.buildInstanceRow(instance)),
          )

    return el(
      'div',
      { class: 'border-t', style: { borderColor: 'var(--color-line)' } },
      header,
      body,
    )
  }

  private buildInstanceRow(instance: InstanceInfo): HTMLElement {
    const tone = instanceTone(instance.status)
    const badgeClass = `badge badge-${tone}`

    const titleRow = el(
      'div',
      { class: 'flex flex-wrap items-center gap-2' },
      el('span', {
        class: 'truncate text-xs font-semibold',
        text: instance.instance_name || instance.instance_id,
      }),
      el('span', { class: badgeClass, text: instanceStatusLabel(instance.status) }),
      ...(instance.spot
        ? [
            el(
              'span',
              { class: 'badge badge-warn' },
              iconSvg(icons.zap, 10),
              el('span', { text: '抢占式' }),
            ),
          ]
        : []),
      ...(instance.instance_charge_type
        ? [
            el('span', {
              class: 'badge badge-muted',
              text: instance.instance_charge_type === 'PrePaid' ? '包年包月' : '按量付费',
            }),
          ]
        : []),
    )

    const metaParts: HTMLElement[] = [
      el(
        'span',
        { class: 'inline-flex items-center gap-1' },
        iconSvg(icons.cpu, 10),
        el('span', { text: instance.instance_type || '—' }),
      ),
      el(
        'span',
        { class: 'inline-flex items-center gap-1' },
        iconSvg(icons.globe, 10),
        el('span', { text: instance.region_id }),
      ),
    ]
    if (instance.public_ip) metaParts.push(el('span', { text: `公网 ${instance.public_ip}` }))
    if (instance.private_ip) metaParts.push(el('span', { text: `内网 ${instance.private_ip}` }))
    metaParts.push(el('span', { class: 'opacity-70', text: instance.instance_id }))

    const metaRow = el(
      'div',
      {
        class: 'mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[0.8125rem]',
        style: { color: 'var(--color-ink-subtle)' },
      },
      ...metaParts,
    )

    const controls = el(
      'div',
      { class: 'flex flex-wrap items-center gap-2' },
      ...(instance.spot ? [this.buildKeepAliveSwitch(instance)] : []),
      this.actionButton({
        key: `${instance.instance_id}:start`,
        label: '开机',
        icon: icons.play,
        className: 'btn-ghost btn-sm',
        disabled: instance.status.toLowerCase() === 'running',
        onClick: () => this.toggleInstance(instance, true),
      }),
      this.actionButton({
        key: `${instance.instance_id}:stop`,
        label: '关机',
        icon: icons.power,
        className: 'btn-danger btn-sm',
        disabled: instance.status.toLowerCase() === 'stopped',
        onClick: () => this.toggleInstance(instance, false),
      }),
    )

    return el(
      'li',
      { class: 'px-5 py-3' },
      el(
        'div',
        { class: 'flex flex-wrap items-start justify-between gap-3' },
        el('div', { class: 'min-w-0 flex-1' }, titleRow, metaRow),
        controls,
      ),
    )
  }

  /** 逐实例抢占式保活开关。 */
  private buildKeepAliveSwitch(instance: InstanceInfo): HTMLElement {
    const on = this.keepAliveOverride.get(instance.instance_id) ?? instance.keep_alive
    const busyKey = `${instance.instance_id}:keepalive`

    const track = el('span', {
      class: 'switch',
      role: 'switch',
      tabindex: '0',
      'aria-checked': String(on),
      'aria-label': '抢占式保活',
      dataset: { on: String(on) },
    })
    track.append(el('span', { class: 'switch-knob' }))

    const handler = (event: Event): void => {
      event.preventDefault()
      if (this.busy.has(busyKey)) return
      void this.toggleKeepAlive(instance)
    }
    track.addEventListener('click', handler)
    track.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') handler(event)
    })

    return el(
      'label',
      {
        class: 'flex cursor-pointer items-center gap-1.5 text-[0.8125rem]',
        title: this.account.spot_keep_alive
          ? '账号级保活已开启'
          : '账号级保活已关闭，逐实例开关不会生效',
      },
      track,
      el('span', { text: '保活' }),
    )
  }

  private buildThresholdBanner(): HTMLElement {
    return el(
      'div',
      {
        class: 'flex items-start gap-2 border-t px-5 py-2.5 text-[0.8125rem]',
        style: {
          borderColor: 'var(--color-line)',
          backgroundColor: 'var(--color-danger-soft)',
          color: 'var(--color-danger)',
        },
      },
      iconSvg(icons.alert, 13),
      el('span', {
        class: 'leading-relaxed',
        text: '本月已触发流量熔断，禁止拉起实例。',
      }),
    )
  }

  // -------------------------------------------------------------------------
  // 按钮
  // -------------------------------------------------------------------------

  private actionButton(spec: ActionSpec): HTMLButtonElement {
    const node = el('button', {
      class: `btn ${spec.className}`,
      type: 'button',
      title: spec.title ?? spec.label,
      'aria-label': spec.title ?? spec.label,
    }) as HTMLButtonElement
    node.disabled = this.busy.has(spec.key) || Boolean(spec.disabled)
    // label 为空时只显示图标（上游的图标按钮形态）
    const labelPart = spec.label ? [el('span', { text: spec.label })] : []
    replaceChildren(
      node,
      ...(this.busy.has(spec.key)
        ? [iconSvg(icons.spinner, 15, 'animate-spin')]
        : [iconSvg(spec.icon, 15), ...labelPart]),
    )
    node.addEventListener('click', () => {
      if (node.disabled) return
      void spec.onClick()
    })
    this.buttons.push({ spec, node })
    return node
  }

  // -------------------------------------------------------------------------
  // 动作
  // -------------------------------------------------------------------------

  private markBusy(key: string, active: boolean): void {
    if (active) this.busy.add(key)
    else this.busy.delete(key)
    this.syncButtons()
    // 保活开关不在 buttons 里，需要重绘实例区才能反映忙碌态
    if (key.endsWith(':keepalive')) this.weightlessRefreshKeepAliveSwitch()
  }

  /** 保活开关没有独立的忙碌态渲染，重建卡片是最简单的可靠做法。 */
  private weightlessRefreshKeepAliveSwitch(): void {
    this.rebuild()
  }

  private async refreshAccount(): Promise<void> {
    if (this.busy.has('refresh')) return
    this.markBusy('refresh', true)
    try {
      await api.refreshAccount(this.account.id)
      toast(`${this.account.name} 已刷新`, 'ok')
      await afterAccountChanged()
    } catch (error) {
      reportError(error, '刷新失败')
    } finally {
      this.markBusy('refresh', false)
    }
  }

  /** 批量开关机按钮。无可用实例时禁用，避免点了没反应。 */
  private batchButton(
    label: string,
    key: string,
    start: boolean,
    disabled: boolean,
  ): HTMLButtonElement {
    const busy = this.busy.has(key)
    return el(
      'button',
      {
        class: 'btn btn-ghost btn-sm',
        type: 'button',
        disabled: disabled || busy,
        title: disabled ? '没有需要操作的实例' : label,
        on: { click: () => void this.batchInstances(start, key) },
      },
      ...(busy
        ? [iconSvg(icons.spinner, 12, 'animate-spin')]
        : [el('span', { text: label })]),
    ) as HTMLButtonElement
  }

  private async batchInstances(start: boolean, key: string): Promise<void> {
    if (this.busy.has(key)) return
    this.markBusy(key, true)
    try {
      const job = await api.batchInstances(this.account.id, start)
      toast(job.error_msg || (start ? '已提交批量开机' : '已提交批量关机'), 'ok')
      await afterAccountChanged()
    } catch (error) {
      reportError(error, start ? '批量开机失败' : '批量关机失败')
    } finally {
      this.markBusy(key, false)
    }
  }

  private async toggleInstance(instance: InstanceInfo, start: boolean): Promise<void> {
    const key = `${instance.instance_id}:${start ? 'start' : 'stop'}`
    if (this.busy.has(key)) return
    this.markBusy(key, true)
    try {
      if (start) {
        await api.startInstance(this.account.id, instance.instance_id)
      } else {
        await api.stopInstance(this.account.id, instance.instance_id)
      }
      toast(
        `${instance.instance_name || instance.instance_id} ${start ? '已开机' : '已关机'}`,
        'ok',
      )
      await afterAccountChanged()
    } catch (error) {
      reportError(error, start ? '开机失败' : '关机失败')
    } finally {
      this.markBusy(key, false)
    }
  }

  private async toggleKeepAlive(instance: InstanceInfo): Promise<void> {
    const key = `${instance.instance_id}:keepalive`
    if (this.busy.has(key)) return
    const next = !(this.keepAliveOverride.get(instance.instance_id) ?? instance.keep_alive)
    this.markBusy(key, true)
    try {
      await api.setKeepAlive(this.account.id, instance.instance_id, next)
      this.keepAliveOverride.set(instance.instance_id, next)
      toast(`已${next ? '开启' : '关闭'} ${instance.instance_id} 的抢占式保活`, 'ok')
    } catch (error) {
      reportError(error, '保活开关更新失败')
    } finally {
      this.markBusy(key, false)
    }
  }
}

/** 账号卡片列表容器（负责增量更新）。 */
export class AccountList {
  readonly element: HTMLElement

  private readonly cards = new Map<number, AccountCard>()

  constructor(private readonly onEdit?: (accountId: number) => void) {
    // 两列网格，与上游一致；窄屏单列
    this.element = el('section', {
      class: 'grid gap-4',
      style: { gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))' },
    })
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
        const card = new AccountCard(account, this.onEdit)
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

  /** 当前卡片数量。 */
  get size(): number {
    return this.cards.size
  }
}
