/**
 * 设置弹窗（对应原版 `SettingsModal.vue`）
 * ============================================================================
 * 五个标签页：阿里云账号 CRUD / Telegram / Bark / 日报 / 系统。
 *
 * 交互约定：
 * * 所有保存都在弹窗内就地反馈（顶部提示条），不关闭弹窗；
 * * 凭据字段（Secret / Token / Device Key）永不回显，只显示「已配置」；
 *   留空表示不修改，另有显式「清除」勾选框；
 * * 「测试发送」「立即推送日报」走异步 Job，期间按钮禁用。
 *
 * 表单状态统一放在 `draft` 对象里，渲染时读它、输入时写它。
 * 这样切换标签页再切回来，用户填了一半的内容不会丢。
 */

import {
  api,
  ApiError,
  type AccountDto,
  type AccountInput,
  type BarkUpdate,
  type NotifyChannel,
  type OverLimitAction,
  type PushLevel,
  type SettingsResponse,
  type SiteType,
  type StopMode,
  type TelegramUpdate,
  type TurnstileUpdate,
} from '@/api/client'
import { el, iconSvg, onEscape, replaceChildren } from '@/lib/dom'
import { icons, type IconNode } from '@/lib/icons'
import { afterSettingsChanged, pushDailyReport, testNotification } from '@/lib/actions'
import { toast } from '@/lib/store'

type Tab = 'accounts' | 'turnstile' | 'telegram' | 'bark' | 'report' | 'system'

/** 账号表单。 */
interface AccountForm {
  id: number | null
  name: string
  siteType: SiteType
  accessKeyId: string
  accessKeySecret: string
  regionsText: string
  trafficLimitGb: number
  overLimitAction: OverLimitAction
  stopMode: StopMode
  scheduleStart: string
  scheduleStop: string
  spotKeepAlive: boolean
  enabled: boolean
}

/** 空账号表单。 */
function blankAccountForm(): AccountForm {
  return {
    id: null,
    name: '',
    siteType: 'china',
    accessKeyId: '',
    accessKeySecret: '',
    regionsText: 'cn-hangzhou\ncn-shanghai\ncn-beijing\ncn-shenzhen',
    trafficLimitGb: 20,
    overLimitAction: 'stop_and_notify',
    stopMode: 'StopCharging',
    scheduleStart: '',
    scheduleStop: '',
    spotKeepAlive: false,
    enabled: true,
  }
}

/** 由 DTO 生成表单（Secret 永远留空）。 */
function formFromAccount(account: AccountDto): AccountForm {
  return {
    id: account.id,
    name: account.name,
    siteType: account.site_type,
    accessKeyId: account.access_key_id,
    accessKeySecret: '',
    regionsText: account.regions.join('\n'),
    trafficLimitGb: account.traffic_limit_gb,
    overLimitAction: account.over_limit_action,
    stopMode: account.stop_mode,
    scheduleStart: account.schedule_start_time ?? '',
    scheduleStop: account.schedule_stop_time ?? '',
    spotKeepAlive: account.spot_keep_alive,
    enabled: account.enabled,
  }
}

/** 设置弹窗。 */
export class SettingsModal {
  readonly element: HTMLDivElement

  private settings: SettingsResponse | null = null
  private activeTab: Tab = 'accounts'

  private readonly content: HTMLDivElement
  private readonly notice: HTMLDivElement
  private readonly tabButtons = new Map<Tab, HTMLButtonElement>()

  private form: AccountForm = blankAccountForm()
  private formOpen = false
  private confirmDeleteId: number | null = null
  private saving = false
  private testing: NotifyChannel | 'report' | null = null

  private turnstileDraft = {
    enabled: false,
    siteKey: '',
    secretKey: '',
    clearSecret: false,
  }

  private telegramDraft = {
    enabled: false,
    chatId: '',
    apiHost: '',
    token: '',
    clearToken: false,
  }

  private barkDraft = {
    enabled: false,
    serverUrl: 'https://api.day.app',
    deviceKey: '',
    clearDeviceKey: false,
    normalLevel: 'active' as PushLevel,
    alertLevel: 'critical' as PushLevel,
  }

  private reportDraft = { enabled: false, time: '09:00' }
  private timezoneDraft = 'UTC+8'

  private removeEscListener: (() => void) | null = null

  constructor() {
    this.content = el('div', { class: 'scroll-thin min-h-0 flex-1 overflow-y-auto p-5' })
    this.notice = el('div', {
      class: 'hidden items-start gap-2 border-b px-5 py-2 text-xs',
      style: { borderColor: 'var(--color-line)' },
    })

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
          class: 'card flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': '系统设置',
        },
        this.buildHeader(),
        this.notice,
        el(
          'div',
          { class: 'flex min-h-0 flex-1 flex-col md:flex-row' },
          this.buildNav(),
          this.content,
        ),
      ),
    )
  }

  // -------------------------------------------------------------------------
  // 打开 / 关闭 / 同步
  // -------------------------------------------------------------------------

  /** 打开弹窗。 */
  open(settings: SettingsResponse | null): void {
    this.settings = settings
    this.syncDrafts()
    this.activeTab = 'accounts'
    this.formOpen = false
    this.form = blankAccountForm()
    this.confirmDeleteId = null
    this.hideNotice()
    this.element.classList.remove('hidden')
    this.element.style.display = 'flex'
    this.renderNav()
    this.renderContent()
    this.removeEscListener = onEscape(() => this.close())
    requestAnimationFrame(() => {
      this.element.querySelector<HTMLElement>('input, button')?.focus()
    })
  }

  /** 关闭弹窗。 */
  close(): void {
    this.element.classList.add('hidden')
    this.element.style.display = 'none'
    this.removeEscListener?.()
    this.removeEscListener = null
  }

  /**
   * 外部数据刷新（store 里的 settings 变了）。
   *
   * **只更新数据，不重渲染**。弹窗是一个正在编辑的表单：任何 store 变更
   * （包括本弹窗自己保存后触发的刷新）都不能冲掉用户已经输入的内容。
   * 需要重渲染的时机全部由弹窗内部显式控制：
   * * 保存成功后：`syncDrafts()` + `renderContent()`（用服务端最新值覆盖草稿）
   * * 切换标签页：`renderContent()`
   * * 打开弹窗：`open()` 内部同步
   */
  update(settings: SettingsResponse | null): void {
    this.settings = settings
  }

  /** DTO -> 本地草稿。 */
  private syncDrafts(): void {
    const settings = this.settings
    if (!settings) return

    this.turnstileDraft = {
      enabled: settings.turnstile.enabled,
      siteKey: settings.turnstile.site_key,
      secretKey: '',
      clearSecret: false,
    }

    this.telegramDraft = {
      enabled: settings.telegram.enabled,
      chatId: settings.telegram.chat_id ?? '',
      apiHost: settings.telegram.api_host ?? '',
      token: '',
      clearToken: false,
    }

    this.barkDraft = {
      enabled: settings.bark.enabled,
      serverUrl: settings.bark.server_url,
      deviceKey: '',
      clearDeviceKey: false,
      normalLevel: settings.bark.normal_level,
      alertLevel: settings.bark.alert_level,
    }

    this.reportDraft = {
      enabled: settings.daily_report.enabled,
      time: settings.daily_report.time,
    }
    this.timezoneDraft = settings.timezone
  }

  // -------------------------------------------------------------------------
  // 骨架
  // -------------------------------------------------------------------------

  private buildHeader(): HTMLElement {
    return el(
      'header',
      {
        class: 'flex items-center justify-between gap-3 border-b px-5 py-3',
        style: { borderColor: 'var(--color-line)' },
      },
      el('h2', { class: 'text-sm font-semibold', text: '系统设置' }),
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
    )
  }

  private buildNav(): HTMLElement {
    const nav = el('nav', {
      class:
        'flex shrink-0 gap-1 overflow-x-auto border-b p-2 md:w-40 md:flex-col md:border-r md:border-b-0',
      style: { borderColor: 'var(--color-line)' },
    })

    const tabs: { key: Tab; label: string; icon: IconNode }[] = [
      { key: 'accounts', label: '阿里云账号', icon: icons.server },
      { key: 'turnstile', label: '人机校验', icon: icons.shield },
      { key: 'telegram', label: 'Telegram', icon: icons.send },
      { key: 'bark', label: 'Bark', icon: icons.phone },
      { key: 'report', label: '日报', icon: icons.bell },
      { key: 'system', label: '系统', icon: icons.key },
    ]

    for (const tab of tabs) {
      const button = el('button', {
        class: 'btn btn-sm justify-start whitespace-nowrap',
        type: 'button',
        style: { borderColor: 'transparent' },
        on: {
          click: () => {
            this.activeTab = tab.key
            this.formOpen = false
            this.confirmDeleteId = null
            this.renderNav()
            this.renderContent()
          },
        },
      }) as HTMLButtonElement
      replaceChildren(button, iconSvg(tab.icon, 13), el('span', { text: tab.label }))
      this.tabButtons.set(tab.key, button)
      nav.append(button)
    }

    // 初始高亮
    queueMicrotask(() => this.renderNav())
    return nav
  }

  private renderNav(): void {
    for (const [key, button] of this.tabButtons) {
      button.className =
        key === this.activeTab
          ? 'btn btn-primary btn-sm justify-start whitespace-nowrap'
          : 'btn btn-ghost btn-sm justify-start whitespace-nowrap'
      button.style.borderColor = 'transparent'
    }
  }

  private showNotice(text: string, tone: 'ok' | 'danger' | 'warn' = 'ok'): void {
    this.notice.classList.remove('hidden')
    this.notice.classList.add('flex')
    this.notice.style.backgroundColor =
      tone === 'danger'
        ? 'var(--color-danger-soft)'
        : tone === 'warn'
          ? 'var(--color-warn-soft)'
          : 'var(--color-ok-soft)'
    this.notice.style.color =
      tone === 'danger'
        ? 'var(--color-danger)'
        : tone === 'warn'
          ? 'var(--color-warn)'
          : 'var(--color-ok)'
    replaceChildren(
      this.notice,
      iconSvg(tone === 'ok' ? icons.check : icons.alert, 13),
      el('span', { class: 'leading-relaxed', text }),
    )
  }

  private hideNotice(): void {
    this.notice.classList.add('hidden')
    this.notice.classList.remove('flex')
    this.notice.replaceChildren()
  }

  // -------------------------------------------------------------------------
  // 通用表单控件
  // -------------------------------------------------------------------------

  /** 输入框 + 标签。 */
  private field(label: string, control: HTMLElement, hint?: string): HTMLElement {
    return el(
      'div',
      {},
      el('label', { class: 'label', text: label }),
      control,
      ...(hint
        ? [
            el('p', {
              class: 'mt-1 text-[10px]',
              style: { color: 'var(--color-ink-subtle)' },
              text: hint,
            }),
          ]
        : []),
    )
  }

  /** 文本输入，onInput 立即写回。 */
  private textInput(
    initial: string,
    onInput: (value: string) => void,
    attrs: { type?: string; placeholder?: string; mono?: boolean; autocomplete?: string } = {},
  ): HTMLInputElement {
    const input = el('input', {
      class: attrs.mono === false ? 'input' : 'input font-mono',
      type: attrs.type ?? 'text',
      placeholder: attrs.placeholder ?? '',
      autocomplete: attrs.autocomplete ?? 'off',
    }) as HTMLInputElement
    input.value = initial
    input.addEventListener('input', () => onInput(input.value))
    return input
  }

  /** 数值输入。 */
  private numberInput(initial: number, onInput: (value: number) => void): HTMLInputElement {
    const input = el('input', {
      class: 'input',
      type: 'number',
      min: '0.1',
      step: '0.1',
    }) as HTMLInputElement
    input.value = String(initial)
    input.addEventListener('input', () => {
      const parsed = Number(input.value)
      onInput(Number.isFinite(parsed) ? parsed : 0)
    })
    return input
  }

  /** 下拉框。 */
  private selectInput<T extends string>(
    initial: T,
    options: { value: T; label: string }[],
    onChange: (value: T) => void,
  ): HTMLSelectElement {
    const node = el('select', { class: 'input' }) as HTMLSelectElement
    for (const option of options) {
      node.append(el('option', { value: option.value, text: option.label }))
    }
    node.value = initial
    node.addEventListener('change', () => onChange(node.value as T))
    return node
  }

  /** 开关。 */
  private switchControl(
    label: string,
    get: () => boolean,
    set: (value: boolean) => void,
  ): HTMLElement {
    const track = el('span', {
      class: 'switch',
      role: 'switch',
      tabindex: '0',
      'aria-checked': String(get()),
      'aria-label': label,
      dataset: { on: String(get()) },
    })
    track.append(el('span', { class: 'switch-knob' }))

    const toggle = (event: Event): void => {
      event.preventDefault()
      const next = !get()
      set(next)
      track.dataset.on = String(next)
      track.setAttribute('aria-checked', String(next))
    }
    track.addEventListener('click', toggle)
    track.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') toggle(event)
    })

    return el(
      'label',
      { class: 'flex cursor-pointer items-center gap-2 text-xs' },
      track,
      el('span', { text: label }),
    )
  }

  /** 复选框行。 */
  private checkboxRow(label: string, onChange: (checked: boolean) => void): HTMLElement {
    const box = el('input', { type: 'checkbox' }) as HTMLInputElement
    box.addEventListener('change', () => onChange(box.checked))
    return el(
      'label',
      {
        class: 'flex cursor-pointer items-center gap-2 text-[11px]',
        style: { color: 'var(--color-ink-muted)' },
      },
      box,
      el('span', { text: label }),
    )
  }

  /** 表单提交按钮。 */
  private submitButton(label: string): HTMLButtonElement {
    return el(
      'button',
      { class: 'btn btn-primary', type: 'submit' },
      el('span', { text: label }),
    ) as HTMLButtonElement
  }

  /** 异步按钮（测试发送 / 推送日报）。 */
  private asyncButton(
    label: string,
    icon: IconNode,
    key: NotifyChannel | 'report',
    action: () => Promise<void>,
  ): HTMLButtonElement {
    const button = el('button', { class: 'btn btn-ghost', type: 'button' }) as HTMLButtonElement

    const paint = (busy: boolean): void => {
      button.disabled = busy || this.testing !== null
      replaceChildren(
        button,
        ...(busy ? [iconSvg(icons.spinner, 13, 'animate-spin')] : [iconSvg(icon, 13)]),
        el('span', { text: label }),
      )
    }

    paint(this.testing === key)
    button.addEventListener('click', async () => {
      if (this.testing !== null) return
      this.testing = key
      paint(true)
      try {
        await action()
      } finally {
        this.testing = null
        paint(false)
      }
    })
    return button
  }

  // -------------------------------------------------------------------------
  // 内容分发
  // -------------------------------------------------------------------------

  private renderContent(): void {
    switch (this.activeTab) {
      case 'accounts':
        this.renderAccounts()
        break
      case 'telegram':
        this.renderTelegram()
        break
      case 'bark':
        this.renderBark()
        break
      case 'report':
        this.renderReport()
        break
      case 'turnstile':
        this.renderTurnstile()
        break
      case 'system':
        this.renderSystem()
        break
    }
  }

  // -------------------------------------------------------------------------
  // 账号
  // -------------------------------------------------------------------------

  private renderAccounts(): void {
    const accounts = this.settings?.accounts ?? []

    const header = el(
      'div',
      { class: 'flex items-start justify-between gap-3' },
      el(
        'div',
        {},
        el('h3', { class: 'text-xs font-semibold', text: '阿里云账号' }),
        el('p', {
          class: 'mt-0.5 text-[11px]',
          style: { color: 'var(--color-ink-subtle)' },
          text: 'AccessKey Secret 使用 XChaCha20-Poly1305 加密后存入 D1，永不回显。',
        }),
      ),
      this.formOpen
        ? el('span')
        : el(
            'button',
            {
              class: 'btn btn-primary btn-sm',
              type: 'button',
              on: {
                click: () => {
                  this.form = blankAccountForm()
                  this.formOpen = true
                  this.renderContent()
                },
              },
            },
            iconSvg(icons.plus, 13),
            el('span', { text: '新增' }),
          ),
    )

    const body = this.formOpen ? this.buildAccountForm() : this.buildAccountList(accounts)
    replaceChildren(this.content, el('div', { class: 'space-y-4' }, header, body))
  }

  private buildAccountList(accounts: AccountDto[]): HTMLElement {
    if (accounts.length === 0) {
      return el('div', {
        class: 'rounded-lg border border-dashed px-3 py-6 text-center text-[11px]',
        style: {
          borderColor: 'var(--color-line)',
          color: 'var(--color-ink-subtle)',
        },
        text: '还没有添加阿里云账号，点击右上角「新增」开始。',
      })
    }

    const list = el('ul', { class: 'space-y-2' })

    for (const account of accounts) {
      const titleRow = el(
        'div',
        { class: 'flex flex-wrap items-center gap-1.5' },
        el('span', { class: 'truncate text-xs font-semibold', text: account.name }),
        el('span', { class: 'badge badge-brand', text: account.site_label }),
        ...(account.enabled
          ? []
          : [el('span', { class: 'badge badge-muted', text: '已停用' })]),
      )

      const metaRow = el('div', {
        class: 'mt-1 font-mono text-[11px]',
        style: { color: 'var(--color-ink-subtle)' },
        text: `${account.access_key_id_masked} · 阈值 ${account.traffic_limit_gb} GB · ${account.regions.length} 个地域`,
      })

      const actions = el(
        'div',
        { class: 'flex items-center gap-1.5' },
        el(
          'button',
          {
            class: 'btn btn-ghost btn-sm',
            type: 'button',
            on: {
              click: () => {
                this.form = formFromAccount(account)
                this.formOpen = true
                this.renderContent()
              },
            },
          },
          iconSvg(icons.pencil, 12),
          el('span', { text: '编辑' }),
        ),
        el(
          'button',
          {
            class: 'btn btn-danger btn-sm',
            type: 'button',
            on: {
              click: () => {
                this.confirmDeleteId = this.confirmDeleteId === account.id ? null : account.id
                this.renderContent()
              },
            },
          },
          iconSvg(icons.trash, 12),
          el('span', { text: '删除' }),
        ),
      )

      const children: HTMLElement[] = [
        el(
          'div',
          { class: 'flex flex-wrap items-center justify-between gap-2' },
          el('div', { class: 'min-w-0' }, titleRow, metaRow),
          actions,
        ),
      ]

      if (this.confirmDeleteId === account.id) {
        children.push(
          el(
            'div',
            {
              class:
                'mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md px-2.5 py-2 text-[11px]',
              style: {
                backgroundColor: 'var(--color-danger-soft)',
                color: 'var(--color-danger)',
              },
            },
            el('span', { text: '删除后该账号的快照与流量历史会一并清除，操作不可恢复。' }),
            el(
              'div',
              { class: 'flex gap-1.5' },
              el('button', {
                class: 'btn btn-ghost btn-sm',
                type: 'button',
                text: '取消',
                on: {
                  click: () => {
                    this.confirmDeleteId = null
                    this.renderContent()
                  },
                },
              }),
              el(
                'button',
                {
                  class: 'btn btn-danger btn-sm',
                  type: 'button',
                  on: { click: () => void this.deleteAccount(account.id) },
                },
                el('span', { text: '确认删除' }),
              ),
            ),
          ),
        )
      }

      list.append(
        el(
          'li',
          {
            class: 'rounded-lg border px-3 py-2.5',
            style: { borderColor: 'var(--color-line)' },
          },
          ...children,
        ),
      )
    }

    return list
  }

  private buildAccountForm(): HTMLElement {
    const form = this.form

    const regionsTextarea = el('textarea', {
      class: 'input scroll-thin font-mono',
      rows: '3',
    }) as HTMLTextAreaElement
    regionsTextarea.value = form.regionsText
    regionsTextarea.addEventListener('input', () => {
      this.form.regionsText = regionsTextarea.value
    })

    const scheduleStart = this.textInput(form.scheduleStart, (value) => {
      this.form.scheduleStart = value
    }, { placeholder: '08:00' })

    const scheduleStop = this.textInput(form.scheduleStop, (value) => {
      this.form.scheduleStop = value
    }, { placeholder: '23:00' })

    return el(
      'form',
      {
        class: 'space-y-3',
        on: {
          submit: (event) => {
            event.preventDefault()
            void this.submitAccount()
          },
        },
      },
      el(
        'div',
        { class: 'flex items-center justify-between' },
        el('h4', {
          class: 'text-xs font-semibold',
          text: form.id === null ? '新增账号' : `编辑账号 #${form.id}`,
        }),
        el(
          'button',
          {
            class: 'btn btn-ghost btn-sm',
            type: 'button',
            on: {
              click: () => {
                this.formOpen = false
                this.form = blankAccountForm()
                this.renderContent()
              },
            },
          },
          iconSvg(icons.chevronDown, 12),
          el('span', { text: '收起' }),
        ),
      ),

      el(
        'div',
        { class: 'grid gap-3 sm:grid-cols-2' },
        this.field(
          '账号名称',
          this.textInput(form.name, (value) => {
            this.form.name = value
          }, { placeholder: '例如：生产环境', mono: false }),
        ),
        this.field(
          '站点',
          this.selectInput(
            form.siteType,
            [
              { value: 'china', label: '中国站（aliyuncs.com）' },
              { value: 'intl', label: '国际站（ap-southeast-1）' },
            ],
            (value) => {
              this.form.siteType = value
            },
          ),
        ),
        this.field(
          'AccessKey ID',
          this.textInput(form.accessKeyId, (value) => {
            this.form.accessKeyId = value
          }, { placeholder: 'LTAI...' }),
        ),
        this.field(
          'AccessKey Secret',
          this.textInput(form.accessKeySecret, (value) => {
            this.form.accessKeySecret = value
          }, {
            type: 'password',
            placeholder: form.id === null ? '必填' : '留空表示不修改',
            autocomplete: 'new-password',
          }),
        ),
      ),

      this.field('地域列表', regionsTextarea, '每行一个地域 ID，留空使用默认四个'),

      el(
        'div',
        { class: 'grid gap-3 sm:grid-cols-3' },
        this.field(
          '流量阈值（GB）',
          this.numberInput(form.trafficLimitGb, (value) => {
            this.form.trafficLimitGb = value
          }),
        ),
        this.field(
          '超限动作',
          this.selectInput(
            form.overLimitAction,
            [
              { value: 'stop_and_notify', label: '停机并通知' },
              { value: 'notify_only', label: '仅通知' },
            ],
            (value) => {
              this.form.overLimitAction = value
            },
          ),
        ),
        this.field(
          '停机模式',
          this.selectInput(
            form.stopMode,
            [
              { value: 'StopCharging', label: '节省停机' },
              { value: 'KeepCharging', label: '普通停机' },
            ],
            (value) => {
              this.form.stopMode = value
            },
          ),
        ),
      ),

      el(
        'div',
        { class: 'grid gap-3 sm:grid-cols-2' },
        this.field('每日定时开机', scheduleStart, '格式 HH:MM，留空表示不启用'),
        this.field('每日定时关机', scheduleStop, '格式 HH:MM，留空表示不启用'),
      ),

      el(
        'div',
        { class: 'flex flex-wrap items-center gap-4 pt-1' },
        this.switchControl(
          '抢占式保活',
          () => this.form.spotKeepAlive,
          (value) => {
            this.form.spotKeepAlive = value
          },
        ),
        this.switchControl(
          '启用该账号',
          () => this.form.enabled,
          (value) => {
            this.form.enabled = value
          },
        ),
      ),

      el(
        'div',
        {
          class: 'flex justify-end gap-2 border-t pt-3',
          style: { borderColor: 'var(--color-line)' },
        },
        el('button', {
          class: 'btn btn-ghost',
          type: 'button',
          text: '取消',
          on: {
            click: () => {
              this.formOpen = false
              this.form = blankAccountForm()
              this.renderContent()
            },
          },
        }),
        el(
          'button',
          { class: 'btn btn-primary', type: 'submit' },
          el('span', { text: form.id === null ? '创建账号' : '保存修改' }),
        ),
      ),
    )
  }

  /** 解析地域文本。 */
  private parsedRegions(): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    for (const raw of this.form.regionsText.split(/[\s,，]+/)) {
      const region = raw.trim()
      if (!region || seen.has(region)) continue
      seen.add(region)
      out.push(region)
    }
    return out
  }

  private async submitAccount(): Promise<void> {
    if (this.saving) return
    const form = this.form

    if (!form.name.trim()) {
      this.showNotice('请填写账号名称', 'warn')
      return
    }
    if (!form.accessKeyId.trim()) {
      this.showNotice('请填写 AccessKey ID', 'warn')
      return
    }
    if (form.id === null && !form.accessKeySecret.trim()) {
      this.showNotice('新增账号必须填写 AccessKey Secret', 'warn')
      return
    }

    const payload: AccountInput = {
      name: form.name.trim(),
      site_type: form.siteType,
      access_key_id: form.accessKeyId.trim(),
      regions: this.parsedRegions(),
      traffic_limit_gb: Number(form.trafficLimitGb),
      over_limit_action: form.overLimitAction,
      stop_mode: form.stopMode,
      schedule_start_time: form.scheduleStart.trim() || null,
      schedule_stop_time: form.scheduleStop.trim() || null,
      spot_keep_alive: form.spotKeepAlive,
      enabled: form.enabled,
    }
    if (form.accessKeySecret.trim()) {
      payload.access_key_secret = form.accessKeySecret.trim()
    }

    this.saving = true
    try {
      if (form.id === null) {
        await api.createAccount(payload)
        this.showNotice('账号已添加', 'ok')
        toast('账号已添加', 'ok')
      } else {
        await api.updateAccount(form.id, payload)
        this.showNotice('账号已更新', 'ok')
      }
      this.formOpen = false
      this.form = blankAccountForm()
      await afterSettingsChanged()
      this.syncDrafts()
      this.renderContent()
    } catch (error) {
      this.showNotice(error instanceof ApiError ? error.message : '保存账号失败', 'danger')
    } finally {
      this.saving = false
    }
  }

  private async deleteAccount(id: number): Promise<void> {
    if (this.saving) return
    this.saving = true
    try {
      await api.deleteAccount(id)
      this.confirmDeleteId = null
      this.showNotice('账号已删除', 'ok')
      await afterSettingsChanged()
      this.syncDrafts()
      this.renderContent()
    } catch (error) {
      this.showNotice(error instanceof ApiError ? error.message : '删除账号失败', 'danger')
    } finally {
      this.saving = false
    }
  }

  // -------------------------------------------------------------------------
  // 人机校验（Turnstile）
  // -------------------------------------------------------------------------

  private renderTurnstile(): void {
    const configured = this.settings?.turnstile.secret_configured ?? false
    const active = this.settings?.turnstile.enabled ?? false

    const siteInput = this.textInput(
      this.turnstileDraft.siteKey,
      (value) => {
        this.turnstileDraft.siteKey = value
      },
      { placeholder: '0x4AAAAAAAA...' },
    )

    const secretInput = this.textInput(
      this.turnstileDraft.secretKey,
      (value) => {
        this.turnstileDraft.secretKey = value
      },
      {
        type: 'password',
        placeholder: configured ? '留空表示不修改' : '0x4AAAAAAAA...',
      },
    )

    const children: HTMLElement[] = [
      el(
        'div',
        {},
        el('h3', { class: 'text-xs font-semibold', text: 'Cloudflare Turnstile' }),
        el('p', {
          class: 'mt-0.5 text-[11px] leading-relaxed',
          style: { color: 'var(--color-ink-subtle)' },
          text: '登录时的人机校验。不填就是不启用 —— 只校验用户名与密码。',
        }),
      ),
      el(
        'div',
        {
          class: 'flex items-start gap-2 rounded-lg px-3 py-2 text-[11px]',
          style: {
            backgroundColor: active ? 'var(--color-ok-soft)' : 'var(--color-surface-muted)',
            color: active ? 'var(--color-ok)' : 'var(--color-ink-subtle)',
          },
        },
        iconSvg(active ? icons.shield : icons.info, 13),
        el('span', {
          class: 'leading-relaxed',
          text: active
            ? '已启用：登录时浏览器会静默完成校验，判定可疑时才弹出复选框。'
            : '未启用：登录只校验用户名 + 密码，建议仅在完全可信的网络环境下保持关闭。',
        }),
      ),
      el(
        'div',
        {},
        el(
          'label',
          { class: 'label' },
          el('span', { text: '站点公钥 Site Key' }),
        ),
        siteInput,
      ),
      el(
        'div',
        {},
        el(
          'label',
          { class: 'label' },
          el('span', { text: '私钥 Secret Key' }),
          ...(configured ? [el('span', { class: 'badge badge-ok ml-1', text: '已配置' })] : []),
        ),
        secretInput,
      ),
      this.switchControl(
        '启用人机校验',
        () => this.turnstileDraft.enabled,
        (value) => {
          this.turnstileDraft.enabled = value
        },
      ),
    ]

    if (configured) {
      children.push(
        this.checkboxRow('清除已保存的私钥', (checked) => {
          this.turnstileDraft.clearSecret = checked
        }),
      )
    }

    children.push(
      el(
        'p',
        {
          class: 'text-[11px] leading-relaxed',
          style: { color: 'var(--color-ink-subtle)' },
          text: '密钥在 Cloudflare 控制台 → Turnstile → 添加站点 获取。私钥以 XChaCha20-Poly1305 加密后存入 D1，不再以明文下发。',
        },
      ),
      el(
        'div',
        {
          class: 'flex flex-wrap justify-end gap-2 border-t pt-3',
          style: { borderColor: 'var(--color-line)' },
        },
        this.submitButton('保存'),
      ),
    )

    replaceChildren(
      this.content,
      el(
        'form',
        {
          class: 'space-y-4',
          on: {
            submit: (event) => {
              event.preventDefault()
              void this.saveTurnstile()
            },
          },
        },
        ...children,
      ),
    )
  }

  private async saveTurnstile(): Promise<void> {
    if (this.saving) return

    const payload: TurnstileUpdate = {
      enabled: this.turnstileDraft.enabled,
      clear_secret: this.turnstileDraft.clearSecret,
    }
    const siteKey = this.turnstileDraft.siteKey.trim()
    if (siteKey) payload.site_key = siteKey
    const secretKey = this.turnstileDraft.secretKey.trim()
    if (secretKey) payload.secret_key = secretKey

    this.saving = true
    try {
      const settings = await api.updateTurnstile(payload)
      this.settings = settings
      this.showNotice('人机校验设置已保存', 'ok')
      await afterSettingsChanged()
      this.syncDrafts()
      this.renderContent()
    } catch (error) {
      this.showNotice(
        error instanceof ApiError ? error.message : '保存人机校验设置失败',
        'danger',
      )
    } finally {
      this.saving = false
    }
  }

  // -------------------------------------------------------------------------
  // Telegram
  // -------------------------------------------------------------------------

  private renderTelegram(): void {
    const configured = this.settings?.telegram.token_configured ?? false

    const tokenInput = this.textInput(
      this.telegramDraft.token,
      (value) => {
        this.telegramDraft.token = value
      },
      {
        type: 'password',
        placeholder: configured ? '留空表示不修改' : '123456:AA...',
      },
    )

    const chatInput = this.textInput(this.telegramDraft.chatId, (value) => {
      this.telegramDraft.chatId = value
    }, { placeholder: '-1001234567890' })

    const hostInput = this.textInput(this.telegramDraft.apiHost, (value) => {
      this.telegramDraft.apiHost = value
    }, { placeholder: 'https://tg.example.com' })

    const children: HTMLElement[] = [
      el(
        'div',
        {},
        el('h3', { class: 'text-xs font-semibold', text: 'Telegram 通知' }),
        el('p', {
          class: 'mt-0.5 text-[11px]',
          style: { color: 'var(--color-ink-subtle)' },
          text: 'Worker 运行在海外边缘节点，可直连 api.telegram.org；必要时可填自定义反代域名。',
        }),
      ),
      el(
        'div',
        {},
        el(
          'label',
          { class: 'label' },
          el('span', { text: 'Bot Token' }),
          ...(configured ? [el('span', { class: 'badge badge-ok ml-1', text: '已配置' })] : []),
        ),
        tokenInput,
      ),
      this.field('Chat ID', chatInput),
      this.field('自定义 API Host（可选）', hostInput),
      this.switchControl(
        '启用 Telegram 通知',
        () => this.telegramDraft.enabled,
        (value) => {
          this.telegramDraft.enabled = value
        },
      ),
    ]

    if (configured) {
      children.push(
        this.checkboxRow('清除已保存的 Token', (checked) => {
          this.telegramDraft.clearToken = checked
        }),
      )
    }

    children.push(
      el(
        'div',
        {
          class: 'flex flex-wrap justify-between gap-2 border-t pt-3',
          style: { borderColor: 'var(--color-line)' },
        },
        this.asyncButton('测试发送', icons.send, 'telegram', () => testNotification('telegram')),
        this.submitButton('保存'),
      ),
    )

    replaceChildren(
      this.content,
      el(
        'form',
        {
          class: 'space-y-4',
          on: {
            submit: (event) => {
              event.preventDefault()
              void this.saveTelegram()
            },
          },
        },
        ...children,
      ),
    )
  }

  private async saveTelegram(): Promise<void> {
    if (this.saving) return

    const payload: TelegramUpdate = {
      enabled: this.telegramDraft.enabled,
      chat_id: this.telegramDraft.chatId.trim() || null,
      api_host: this.telegramDraft.apiHost.trim() || null,
      clear_token: this.telegramDraft.clearToken,
    }
    if (this.telegramDraft.token.trim()) {
      payload.token = this.telegramDraft.token.trim()
    }

    this.saving = true
    try {
      await api.updateTelegram(payload)
      this.showNotice('Telegram 配置已保存', 'ok')
      await afterSettingsChanged()
      // 已保存的 Token 不再回显：用服务端最新状态重置草稿
      this.syncDrafts()
      this.renderContent()
    } catch (error) {
      this.showNotice(
        error instanceof ApiError ? error.message : '保存 Telegram 配置失败',
        'danger',
      )
    } finally {
      this.saving = false
    }
  }

  // -------------------------------------------------------------------------
  // Bark
  // -------------------------------------------------------------------------

  private renderBark(): void {
    const configured = this.settings?.bark.device_key_configured ?? false

    const serverInput = this.textInput(this.barkDraft.serverUrl, (value) => {
      this.barkDraft.serverUrl = value
    }, { placeholder: 'https://api.day.app' })

    const keyInput = this.textInput(
      this.barkDraft.deviceKey,
      (value) => {
        this.barkDraft.deviceKey = value
      },
      {
        type: 'password',
        placeholder: configured ? '留空表示不修改' : '设备密钥',
      },
    )

    const levelOptions: { value: PushLevel; label: string }[] = [
      { value: 'active', label: 'active（安静）' },
      { value: 'timeSensitive', label: 'timeSensitive（时效）' },
      { value: 'critical', label: 'critical（关键）' },
    ]

    const children: HTMLElement[] = [
      el(
        'div',
        {},
        el('h3', { class: 'text-xs font-semibold', text: 'Bark 通知' }),
        el('p', {
          class: 'mt-0.5 text-[11px]',
          style: { color: 'var(--color-ink-subtle)' },
          text: '通过 HTTPS POST JSON 推送；普通通知与熔断告警可分别设置推送级别。',
        }),
      ),
      this.field('Server URL', serverInput),
      el(
        'div',
        {},
        el(
          'label',
          { class: 'label' },
          el('span', { text: 'Device Key' }),
          ...(configured ? [el('span', { class: 'badge badge-ok ml-1', text: '已配置' })] : []),
        ),
        keyInput,
      ),
      el(
        'div',
        { class: 'grid gap-3 sm:grid-cols-2' },
        this.field(
          '普通通知级别',
          this.selectInput(this.barkDraft.normalLevel, levelOptions, (value) => {
            this.barkDraft.normalLevel = value
          }),
        ),
        this.field(
          '熔断告警级别',
          this.selectInput(this.barkDraft.alertLevel, levelOptions, (value) => {
            this.barkDraft.alertLevel = value
          }),
        ),
      ),
      this.switchControl(
        '启用 Bark 通知',
        () => this.barkDraft.enabled,
        (value) => {
          this.barkDraft.enabled = value
        },
      ),
    ]

    if (configured) {
      children.push(
        this.checkboxRow('清除已保存的 Device Key', (checked) => {
          this.barkDraft.clearDeviceKey = checked
        }),
      )
    }

    children.push(
      el(
        'div',
        {
          class: 'flex flex-wrap justify-between gap-2 border-t pt-3',
          style: { borderColor: 'var(--color-line)' },
        },
        this.asyncButton('测试发送', icons.send, 'bark', () => testNotification('bark')),
        this.submitButton('保存'),
      ),
    )

    replaceChildren(
      this.content,
      el(
        'form',
        {
          class: 'space-y-4',
          on: {
            submit: (event) => {
              event.preventDefault()
              void this.saveBark()
            },
          },
        },
        ...children,
      ),
    )
  }

  private async saveBark(): Promise<void> {
    if (this.saving) return

    const payload: BarkUpdate = {
      enabled: this.barkDraft.enabled,
      server_url: this.barkDraft.serverUrl.trim(),
      normal_level: this.barkDraft.normalLevel,
      alert_level: this.barkDraft.alertLevel,
      clear_device_key: this.barkDraft.clearDeviceKey,
    }
    if (this.barkDraft.deviceKey.trim()) {
      payload.device_key = this.barkDraft.deviceKey.trim()
    }

    this.saving = true
    try {
      await api.updateBark(payload)
      this.showNotice('Bark 配置已保存', 'ok')
      await afterSettingsChanged()
      this.syncDrafts()
      this.renderContent()
    } catch (error) {
      this.showNotice(error instanceof ApiError ? error.message : '保存 Bark 配置失败', 'danger')
    } finally {
      this.saving = false
    }
  }

  // -------------------------------------------------------------------------
  // 日报
  // -------------------------------------------------------------------------

  private renderReport(): void {
    const timeInput = this.textInput(this.reportDraft.time, (value) => {
      this.reportDraft.time = value
    }, { placeholder: '09:00' })

    replaceChildren(
      this.content,
      el(
        'form',
        {
          class: 'space-y-4',
          on: {
            submit: (event) => {
              event.preventDefault()
              void this.saveReport()
            },
          },
        },
        el(
          'div',
          {},
          el('h3', { class: 'text-xs font-semibold', text: '每日日报' }),
          el('p', {
            class: 'mt-0.5 text-[11px]',
            style: { color: 'var(--color-ink-subtle)' },
            text: '到达设定时间后的 40 分钟窗口内推送一次，当天不会重复推送。',
          }),
        ),
        this.field('推送时间（HH:MM，按账号时区）', timeInput),
        this.switchControl(
          '启用每日日报推送',
          () => this.reportDraft.enabled,
          (value) => {
            this.reportDraft.enabled = value
          },
        ),
        el(
          'div',
          {
            class: 'flex flex-wrap justify-between gap-2 border-t pt-3',
            style: { borderColor: 'var(--color-line)' },
          },
          this.asyncButton('立即推送一次', icons.bell, 'report', () => pushDailyReport()),
          this.submitButton('保存'),
        ),
      ),
    )
  }

  private async saveReport(): Promise<void> {
    if (this.saving) return
    if (!/^\d{1,2}:\d{2}$/.test(this.reportDraft.time.trim())) {
      this.showNotice('日报时间格式应为 HH:MM', 'warn')
      return
    }

    this.saving = true
    try {
      await api.updateDailyReport(this.reportDraft.enabled, this.reportDraft.time.trim())
      this.showNotice('日报设置已保存', 'ok')
      await afterSettingsChanged()
      this.syncDrafts()
      this.renderContent()
    } catch (error) {
      this.showNotice(error instanceof ApiError ? error.message : '保存日报设置失败', 'danger')
    } finally {
      this.saving = false
    }
  }

  // -------------------------------------------------------------------------
  // 系统
  // -------------------------------------------------------------------------

  private renderSystem(): void {
    const tzInput = this.textInput(this.timezoneDraft, (value) => {
      this.timezoneDraft = value
    }, { placeholder: 'UTC+8' })

    replaceChildren(
      this.content,
      el(
        'div',
        { class: 'space-y-5' },
        el(
          'div',
          {},
          el('h3', { class: 'text-xs font-semibold', text: '时区' }),
          el('p', {
            class: 'mt-0.5 text-[11px]',
            style: { color: 'var(--color-ink-subtle)' },
            text: '影响账期划分、定时开关机与图表分桶。格式如 UTC+8、UTC-5、UTC+5:30。',
          }),
          el(
            'form',
            {
              class: 'mt-2 flex gap-2',
              on: {
                submit: (event) => {
                  event.preventDefault()
                  void this.saveTimezone()
                },
              },
            },
            tzInput,
            el(
              'button',
              { class: 'btn btn-primary shrink-0', type: 'submit' },
              el('span', { text: '保存' }),
            ),
          ),
        ),
        el(
          'div',
          { class: 'border-t pt-4', style: { borderColor: 'var(--color-line)' } },
          el('h3', { class: 'text-xs font-semibold', text: '登录凭证' }),
          el('p', {
            class: 'mt-0.5 text-[11px]',
            style: { color: 'var(--color-ink-subtle)' },
            text: '管理员用户名与密码由 Worker 环境变量提供，不在后台修改，也不写入数据库。',
          }),
          el(
            'div',
            {
              class: 'mt-2 space-y-1.5 rounded-lg px-3 py-2.5 font-mono text-[11px]',
              style: {
                backgroundColor: 'var(--color-surface-muted)',
                color: 'var(--color-ink-muted)',
              },
            },
            el('div', { text: 'ADMIN_USERNAME' }),
            el('div', { text: 'ADMIN_PASSWORD' }),
          ),
          el('p', {
            class: 'mt-2 text-[11px] leading-relaxed',
            style: { color: 'var(--color-ink-subtle)' },
            text: '轮换方式：Cloudflare 控制台 → Settings → Variables and Secrets 修改后重新部署。改完旧会话不会自动失效，必要时在浏览器清除 Cookie。',
          }),
        ),
        el(
          'div',
          {
            class: 'flex items-start gap-2 rounded-lg px-3 py-2 text-[11px]',
            style: {
              backgroundColor: 'var(--color-surface-muted)',
              color: 'var(--color-ink-subtle)',
            },
          },
          iconSvg(icons.cloud, 13),
          el('span', {
            class: 'leading-relaxed',
            text: '通知凭据与阿里云 Secret 均以 XChaCha20-Poly1305 加密存储，主密钥为 Worker 的 MASTER_KEY 环境变量；轮换主密钥会导致现有密文全部失效。',
          }),
        ),
      ),
    )
  }

  private async saveTimezone(): Promise<void> {
    if (this.saving) return
    this.saving = true
    try {
      await api.updateTimezone(this.timezoneDraft.trim())
      this.showNotice('时区已保存', 'ok')
      await afterSettingsChanged()
      this.syncDrafts()
      this.renderContent()
    } catch (error) {
      this.showNotice(error instanceof ApiError ? error.message : '保存时区失败', 'danger')
    } finally {
      this.saving = false
    }
  }
}
