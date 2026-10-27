/**
 * 设置弹窗
 * ============================================================================
 * 结构照搬上游 `SettingsPanel`：
 *
 *   modal-layer
 *   ├ modal-scrim
 *   └ settings-panel
 *     ├ header         SYSTEM PREFERENCES / 控制台设置 / 关闭
 *     ├ settings-tabs  横排标签
 *     ├ settings-content 逐页内容（settings-section / section-title / form-grid）
 *     └ settings-footer  保存变更
 *
 * 交互约定：
 * * 凭据字段（Secret / Token / Device Key）永不回显，只显示「已配置」，
 *   留空表示不修改；
 * * 表单状态统一放在 `draft` 对象里，渲染时读它、输入时写它，
 *   切换标签页再切回来不会丢用户填了一半的内容。
 */

import {
  api,
  ApiError,
  formatTime,
  relativeTime,
  type AccountDto,
  type AccountInput,
  type BarkUpdate,
  type NotifyChannel,
  type OverLimitAction,
  type PushLevel,
  type SessionDevice,
  type SettingsResponse,
  type SiteType,
  type StopMode,
  type TelegramUpdate,
  type TurnstileUpdate,
} from '@/api/client'
import {
  el,
  eyebrow,
  field,
  iconButton,
  iconSvg,
  inputShell,
  onEscape,
  replaceChildren,
  sectionTitle,
  subtleEmpty,
  textInput,
  toggleRow,
} from '@/lib/dom'
import { icons, type IconNode } from '@/lib/icons'
import { afterSettingsChanged, pushDailyReport, testNotification } from '@/lib/actions'
import { toast } from '@/lib/store'

type Tab = 'accounts' | 'turnstile' | 'telegram' | 'bark' | 'report' | 'system'

/**
 * 可选地域。
 *
 * 与上游保持同一份清单和叫法（「华东 1（杭州）」这种官方编号）。
 * 一个账号只对应一个地域，下拉单选即可。
 */
const REGION_OPTIONS: { value: string; label: string }[] = [
  { value: 'cn-hongkong', label: '中国香港' },
  { value: 'cn-hangzhou', label: '华东 1（杭州）' },
  { value: 'cn-shanghai', label: '华东 2（上海）' },
  { value: 'cn-qingdao', label: '华北 1（青岛）' },
  { value: 'cn-beijing', label: '华北 2（北京）' },
  { value: 'cn-zhangjiakou', label: '华北 3（张家口）' },
  { value: 'cn-huhehaote', label: '华北 5（呼和浩特）' },
  { value: 'cn-wulanchabu', label: '华北 6（乌兰察布）' },
  { value: 'cn-shenzhen', label: '华南 1（深圳）' },
  { value: 'cn-heyuan', label: '华南 2（河源）' },
  { value: 'cn-guangzhou', label: '华南 3（广州）' },
  { value: 'cn-chengdu', label: '西南 1（成都）' },
  { value: 'ap-southeast-1', label: '新加坡' },
  { value: 'ap-northeast-1', label: '日本（东京）' },
  { value: 'ap-northeast-2', label: '韩国（首尔）' },
  { value: 'us-west-1', label: '美国（硅谷）' },
  { value: 'us-east-1', label: '美国（弗吉尼亚）' },
]

/** 账号表单。 */
interface AccountForm {
  id: number | null
  name: string
  siteType: SiteType
  accessKeyId: string
  accessKeySecret: string
  regionId: string
  instanceId: string
  /** 告警阈值（GB）。0 表示不限制也不告警。 */
  trafficThresholdGb: number
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
    regionId: 'cn-hongkong',
    instanceId: '',
    trafficThresholdGb: 0,
    overLimitAction: 'stop_and_notify',
    stopMode: 'StopCharging',
    scheduleStart: '',
    scheduleStop: '',
    spotKeepAlive: false,
    enabled: true,
  }
}

/** 由 DTO 生成表单（AccessKey 类字段永远留空，留空即保持原值）。 */
function formFromAccount(account: AccountDto): AccountForm {
  return {
    id: account.id,
    name: account.name,
    siteType: account.site_type,
    accessKeyId: '',
    accessKeySecret: '',
    regionId: account.region_id,
    instanceId: account.instance_id,
    trafficThresholdGb: account.traffic_threshold_gb,
    overLimitAction: account.over_limit_action,
    stopMode: account.stop_mode,
    scheduleStart: account.schedule_start_time ?? '',
    scheduleStop: account.schedule_stop_time ?? '',
    spotKeepAlive: account.spot_keep_alive,
    enabled: account.enabled,
  }
}

/** 从 UA 提炼可读设备名（与后端 short_device 保持一致的粒度）。 */
function deviceName(ua: string): string {
  const lower = ua.toLowerCase()
  const browser = lower.includes('edg/')
    ? 'Edge'
    : lower.includes('chrome/') && !lower.includes('chromium')
      ? 'Chrome'
      : lower.includes('firefox/')
        ? 'Firefox'
        : lower.includes('safari/')
          ? 'Safari'
          : lower.includes('curl/')
            ? 'curl'
            : lower.trim() === ''
              ? '未知客户端'
              : '其他'
  const platform = lower.includes('iphone')
    ? 'iPhone'
    : lower.includes('ipad')
      ? 'iPad'
      : lower.includes('android')
        ? 'Android'
        : lower.includes('mac os x') || lower.includes('macintosh')
          ? 'macOS'
          : lower.includes('windows')
            ? 'Windows'
            : lower.includes('linux')
              ? 'Linux'
              : ''
  return platform ? `${browser} · ${platform}` : browser
}

/** 选项卡定义。 */
const TABS: { key: Tab; label: string; icon: IconNode }[] = [
  { key: 'accounts', label: '实例', icon: icons.server },
  { key: 'turnstile', label: '人机校验', icon: icons.shield },
  { key: 'telegram', label: 'Telegram', icon: icons.send },
  { key: 'bark', label: 'Bark', icon: icons.phone },
  { key: 'report', label: '日报', icon: icons.bell },
  { key: 'system', label: '系统', icon: icons.settings },
]

/** 设置弹窗。 */
export class SettingsModal {
  readonly element: HTMLDivElement

  private settings: SettingsResponse | null = null
  private activeTab: Tab = 'accounts'

  private readonly content: HTMLDivElement
  private readonly footer: HTMLElement
  private readonly tabButtons = new Map<Tab, HTMLButtonElement>()
  private readonly saveButton: HTMLButtonElement

  private form: AccountForm = blankAccountForm()
  private formOpen = false
  private confirmDeleteId: number | null = null
  private saving = false
  private testing: NotifyChannel | 'report' | null = null

  private turnstileDraft = { enabled: false, siteKey: '', secretKey: '' }
  private telegramDraft = { enabled: false, chatId: '', token: '' }
  private barkDraft = {
    enabled: false,
    serverUrl: 'https://api.day.app',
    deviceKey: '',
    normalLevel: 'active' as PushLevel,
    alertLevel: 'critical' as PushLevel,
  }
  private reportDraft = { enabled: false, time: '09:00' }
  private timezoneDraft = 'UTC+8'
  private advancedDraft = { logLevel: 'error', jobLockMinutes: 10, sessionDays: 14 }

  private devices: SessionDevice[] = []
  private devicesLoaded = false
  private kicking: string | null = null
  private deviceListHost: HTMLDivElement | null = null

  private removeEscListener: (() => void) | null = null

  constructor() {
    this.content = el('div', { class: 'settings-content' })
    this.saveButton = el('button', {
      class: 'button button--primary',
      type: 'button',
      on: { click: () => this.saveActiveTab() },
    }) as HTMLButtonElement
    this.paintSaving(false)
    this.footer = el('footer', { class: 'settings-footer' }, this.saveButton)

    const nav = el('nav', { class: 'settings-tabs' })
    for (const tab of TABS) {
      const button = el('button', {
        type: 'button',
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
      replaceChildren(button, iconSvg(tab.icon, 17), el('span', { text: tab.label }))
      this.tabButtons.set(tab.key, button)
      nav.append(button)
    }

    this.element = el(
      'div',
      { class: 'modal-layer', hidden: true },
      el('div', { class: 'modal-scrim', on: { click: () => this.close() } }),
      el(
        'section',
        {
          class: 'settings-panel',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': '系统设置',
        },
        el(
          'header',
          {},
          el('div', {}, eyebrow('SYSTEM PREFERENCES'), el('h2', { text: '控制台设置' })),
          iconButton({ label: '关闭', icon: icons.close, onClick: () => this.close() }),
        ),
        nav,
        this.content,
        this.footer,
      ),
    )
  }

  // -------------------------------------------------------------------------
  // 打开 / 关闭 / 同步
  // -------------------------------------------------------------------------

  /**
   * 打开弹窗。
   *
   * `startWithNewAccount` 打开后直接进入新增账号表单，供空状态的
   * 「添加实例」按钮使用。
   * `editAccountId` 打开后直接进入指定账号的编辑表单，供卡片上的设置按钮使用。
   */
  open(settings: SettingsResponse | null, startWithNewAccount = false, editAccountId?: number): void {
    this.settings = settings
    this.syncDrafts()
    this.activeTab = 'accounts'
    this.formOpen = startWithNewAccount || editAccountId !== undefined
    this.form = blankAccountForm()
    if (editAccountId !== undefined) {
      const target = settings?.accounts.find((a) => a.id === editAccountId)
      if (target) this.form = formFromAccount(target)
    }
    this.confirmDeleteId = null
    this.devices = []
    this.devicesLoaded = false
    this.deviceListHost = null
    this.element.hidden = false
    document.body.style.overflow = 'hidden'
    this.renderNav()
    this.renderContent()
    this.removeEscListener = onEscape(() => this.close())
  }

  /** 关闭弹窗。 */
  close(): void {
    this.element.hidden = true
    document.body.style.overflow = ''
    this.removeEscListener?.()
    this.removeEscListener = null
  }

  /**
   * 外部数据刷新（store 里的 settings 变了）。
   *
   * **只更新数据，不重渲染**。弹窗是一个正在编辑的表单：任何 store 变更
   * 都不能冲掉用户已经输入的内容。
   */
  update(settings: SettingsResponse | null): void {
    this.settings = settings
  }

  /** DTO -> 本地草稿。 */
  private syncDrafts(): void {
    const settings = this.settings
    if (!settings) return

    // 敏感字段一律不回填：留空即保持原值
    this.turnstileDraft = {
      enabled: settings.turnstile.enabled,
      siteKey: '',
      secretKey: '',
    }
    this.telegramDraft = {
      enabled: settings.telegram.enabled,
      chatId: '',
      token: '',
    }
    this.barkDraft = {
      enabled: settings.bark.enabled,
      serverUrl: settings.bark.server_url,
      deviceKey: '',
      normalLevel: settings.bark.normal_level,
      alertLevel: settings.bark.alert_level,
    }
    this.reportDraft = {
      enabled: settings.daily_report.enabled,
      time: settings.daily_report.time,
    }
    this.timezoneDraft = settings.timezone
    this.advancedDraft = {
      logLevel: settings.advanced.log_level,
      jobLockMinutes: Math.round(settings.advanced.job_lock_ttl_ms / 60_000),
      sessionDays: Math.round(settings.advanced.session_ttl_ms / (24 * 60 * 60 * 1000)),
    }
  }

  // -------------------------------------------------------------------------
  // 通用控件
  // -------------------------------------------------------------------------

  /** 单行输入（带外壳）。 */
  private line(
    initial: string,
    onInput: (value: string) => void,
    options: {
      type?: string
      placeholder?: string
      icon?: IconNode
      suffix?: string
      min?: string
      step?: string
      required?: boolean
    } = {},
  ): HTMLElement {
    const input = textInput({
      type: options.type ?? 'text',
      value: initial,
      placeholder: options.placeholder,
      autocomplete: options.type === 'password' ? 'new-password' : 'off',
      min: options.min,
      step: options.step,
    })
    if (options.required) input.required = true
    input.addEventListener('input', () => onInput(input.value))
    return inputShell({ icon: options.icon, input, suffix: options.suffix })
  }

  /** 数字输入。 */
  private numberLine(
    initial: number,
    onInput: (value: number) => void,
    options: { min?: string; step?: string; suffix?: string } = {},
  ): HTMLElement {
    return this.line(
      String(initial),
      (raw) => {
        const parsed = Number(raw)
        onInput(Number.isFinite(parsed) ? parsed : 0)
      },
      { type: 'number', min: options.min ?? '0.1', step: options.step ?? '1', suffix: options.suffix },
    )
  }

  /** 下拉选择。 */
  private picker<T extends string>(
    initial: T,
    options: { value: T; label: string }[],
    onChange: (value: T) => void,
  ): HTMLElement {
    const node = el('select', { class: 'native-select' }) as HTMLSelectElement
    for (const option of options) {
      node.append(el('option', { value: option.value, text: option.label }))
    }
    node.value = initial
    node.addEventListener('change', () => onChange(node.value as T))
    return node
  }

  /** 「已配置」徽章。 */
  private configuredBadge(configured: boolean): HTMLElement | null {
    return configured ? el('span', { class: 'badge badge-ok', text: '已配置' }) : null
  }

  /** 带徽章的字段标签。 */
  private labeledField(label: string, control: HTMLElement, badge?: HTMLElement | null): HTMLElement {
    const labelNode = el('label', {})
    labelNode.append(el('span', { text: label }))
    if (badge) labelNode.append(badge)
    return el('div', { class: 'field' }, labelNode, control)
  }

  /** 异步按钮（测试发送 / 推送日报）。 */
  private asyncButton(
    label: string,
    icon: IconNode,
    key: NotifyChannel | 'report',
    action: () => Promise<void>,
  ): HTMLButtonElement {
    const button = el('button', {
      class: 'button button--secondary',
      type: 'button',
    }) as HTMLButtonElement

    const paint = (busy: boolean): void => {
      button.disabled = busy || this.testing !== null
      replaceChildren(
        button,
        iconSvg(busy ? icons.spinner : icon, 18, busy ? 'spin' : ''),
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
  // 导航与内容分发
  // -------------------------------------------------------------------------

  private renderNav(): void {
    for (const [key, button] of this.tabButtons) {
      button.classList.toggle('active', key === this.activeTab)
      button.setAttribute('aria-selected', String(key === this.activeTab))
    }
    // 实例页自带「创建 / 保存修改」按钮，日报页有「立即推送」，都不需要底部保存栏
    this.footer.hidden = this.activeTab === 'accounts' || this.activeTab === 'report'
  }

  private renderContent(): void {
    switch (this.activeTab) {
      case 'accounts':
        this.renderAccounts()
        break
      case 'turnstile':
        this.renderTurnstile()
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
      case 'system':
        this.renderSystem()
        break
    }
  }

  private saveActiveTab(): void {
    switch (this.activeTab) {
      case 'turnstile':
        void this.saveTurnstile()
        break
      case 'telegram':
        void this.saveTelegram()
        break
      case 'bark':
        void this.saveBark()
        break
      case 'report':
        void this.saveReport()
        break
      case 'system':
        void this.saveSystem()
        break
      case 'accounts':
        break
    }
  }

  // -------------------------------------------------------------------------
  // 实例
  // -------------------------------------------------------------------------

  private renderAccounts(): void {
    const accounts = this.settings?.accounts ?? []

    const addButton = el(
      'button',
      {
        class: 'button button--secondary button--small',
        type: 'button',
        on: {
          click: () => {
            this.form = blankAccountForm()
            this.formOpen = true
            this.renderContent()
          },
        },
      },
      iconSvg(icons.plus, 18),
      el('span', { text: '添加实例' }),
    )

    const heading = el(
      'div',
      { class: 'section-title-row' },
      sectionTitle({
        icon: icons.server,
        title: '云端实例',
        subtitle: 'ALIYUN ACCOUNTS',
      }),
      addButton,
    )

    const body = this.formOpen ? this.buildAccountForm() : this.buildAccountList(accounts)
    replaceChildren(this.content, el('div', { class: 'settings-section' }, heading, body))
  }

  private buildAccountList(accounts: AccountDto[]): HTMLElement {
    if (accounts.length === 0) {
      return subtleEmpty('尚未配置实例', icons.server)
    }

    const list = el('div', { class: 'account-settings-list' })

    for (const account of accounts) {
      const head = el(
        'div',
        { class: 'account-editor__head' },
        el(
          'div',
          {},
          el('b', { text: account.name }),
          el('small', {
            text: [account.region_name, account.enabled ? '' : '已停用']
              .filter(Boolean)
              .join(' · '),
          }),
        ),
        el(
          'div',
          { class: 'account-editor__actions' },
          iconButton({
            label: '编辑',
            icon: icons.pencil,
            onClick: () => {
              this.form = formFromAccount(account)
              this.formOpen = true
              this.renderContent()
            },
          }),
          iconButton({
            label: '删除',
            icon: icons.trash,
            tone: 'danger',
            onClick: () => {
              this.confirmDeleteId = this.confirmDeleteId === account.id ? null : account.id
              this.renderContent()
            },
          }),
        ),
      )

      const editor = el('div', { class: 'account-editor account-editor--row' }, head)

      if (this.confirmDeleteId === account.id) {
        editor.append(
          el(
            'div',
            { class: 'confirm-strip' },
            el('span', { text: '快照与流量历史将一并删除。' }),
            el(
              'div',
              { class: 'control-group' },
              el('button', {
                class: 'button button--secondary button--small',
                type: 'button',
                text: '取消',
                on: {
                  click: () => {
                    this.confirmDeleteId = null
                    this.renderContent()
                  },
                },
              }),
              el('button', {
                class: 'button button--primary button--small',
                type: 'button',
                text: '确认删除',
                on: { click: () => void this.deleteAccount(account.id) },
              }),
            ),
          ),
        )
      }

      list.append(editor)
    }

    return list
  }

  private buildAccountForm(): HTMLElement {
    const form = this.form

    const scheduleStart = this.line(form.scheduleStart, (value) => {
      this.form.scheduleStart = value
    }, { placeholder: '08:00' })

    const scheduleStop = this.line(form.scheduleStop, (value) => {
      this.form.scheduleStop = value
    }, { placeholder: '23:00' })

    const fields = el(
      'div',
      { class: 'form-grid account-fields' },
      field(
        '账号名称',
        this.line(form.name, (value) => {
          this.form.name = value
        }, { placeholder: '例如：香港主节点' }),
      ),
      field(
        '站点类型',
        this.picker(
          form.siteType,
          [
            { value: 'china', label: '中国站（CNY）' },
            { value: 'intl', label: '国际站（USD）' },
          ],
          (value) => {
            this.form.siteType = value
          },
        ),
      ),
      field(
        'AccessKey ID',
        this.line(form.accessKeyId, (value) => {
          this.form.accessKeyId = value
        }, {
          type: 'password',
          placeholder: form.id === null ? 'LTAI5t…' : '留空保持不变',
        }),
      ),
      field(
        'AccessKey Secret',
        this.line(form.accessKeySecret, (value) => {
          this.form.accessKeySecret = value
        }, {
          type: 'password',
          placeholder: form.id === null ? '输入 Secret' : '留空保持不变',
        }),
      ),
      field(
        '地域',
        this.picker(form.regionId, REGION_OPTIONS, (value) => {
          this.form.regionId = value
        }),
      ),
      field(
        '实例 ID *',
        this.line(form.instanceId, (value) => {
          this.form.instanceId = value
        }, { placeholder: 'i-bp…', required: true }),
      ),
      field(
        '告警阈值（GB）',
        this.numberLine(
          form.trafficThresholdGb,
          (value) => {
            this.form.trafficThresholdGb = value
          },
          { min: '0', suffix: 'GB' },
        ),
      ),
      field(
        '超限动作',
        this.picker(
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
      field(
        '停机模式',
        this.picker(
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
      field('每日定时开机', scheduleStart),
      field('每日定时关机', scheduleStop),
      el(
        'div',
        { class: 'account-fields__full toggle-list' },
        toggleRow({
          title: '抢占式实例保活',
          icon: icons.zap,
          checked: form.spotKeepAlive,
          onChange: (checked) => {
            this.form.spotKeepAlive = checked
          },
        }),
        toggleRow({
          title: '启用该实例',
          icon: icons.power,
          checked: form.enabled,
          onChange: (checked) => {
            this.form.enabled = checked
          },
        }),
      ),
      el(
        'p',
        { class: 'field-hint account-fields__full' },
        el('span', {
          text: '时间格式 HH:MM，留空表示不启用。保活与定时开关可同时开启：定时关机后不再拉起，定时开机后若被抢占回收则由保活补上。',
        }),
      ),
    )

    return el(
      'form',
      {
        class: 'account-editor',
        on: {
          submit: (event) => {
            event.preventDefault()
            void this.submitAccount()
          },
        },
      },
      el(
        'div',
        { class: 'account-editor__head' },
        el('b', { text: form.id === null ? '新增实例' : `编辑「${form.name || form.id}」` }),
      ),
      fields,
      // 提交按钮悬浮在弹窗右下角，与其它设置页的保存栏位置一致
      el(
        'div',
        { class: 'account-editor__submit' },
        el(
          'button',
          { class: 'button button--primary', type: 'submit' },
          el('span', { text: form.id === null ? '创建实例' : '保存修改' }),
        ),
      ),
    )
  }

  private async submitAccount(): Promise<void> {
    if (this.saving) return
    const form = this.form

    if (!form.name.trim()) {
      toast('请填写账号名称', 'warn')
      return
    }
    if (form.id === null && !form.accessKeyId.trim()) {
      toast('请填写 AccessKey ID', 'warn')
      return
    }
    if (form.id === null && !form.accessKeySecret.trim()) {
      toast('新增账号必须填写 AccessKey Secret', 'warn')
      return
    }
    if (!form.instanceId.trim()) {
      toast('请填写实例 ID', 'warn')
      return
    }

    const payload: AccountInput = {
      name: form.name.trim(),
      site_type: form.siteType,
      access_key_id: form.accessKeyId.trim(),
      region_id: form.regionId,
      instance_id: form.instanceId.trim(),
      traffic_threshold_gb: form.trafficThresholdGb,
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
        const created = await api.createAccount(payload)
        // 新建账号还没有快照，不立即采集的话卡片会一直是空的，
        // 要等到下一轮 Cron（最长 15 分钟）才有数据。
        // 采集失败不阻断创建：账号已经建好了，卡片会显示「等待首次同步」。
        let collected = true
        try {
          await api.refreshAccount(created.id)
        } catch {
          collected = false
        }
        toast(
          collected ? '实例已添加' : '实例已添加，首次采集失败，可稍后手动刷新',
          collected ? 'ok' : 'warn',
        )
      } else {
        await api.updateAccount(form.id, payload)
        toast('实例已更新', 'ok')
      }
      this.formOpen = false
      this.form = blankAccountForm()
      await afterSettingsChanged()
      this.syncDrafts()
      this.renderContent()
    } catch (error) {
      toast(error instanceof ApiError ? error.message : '保存失败', 'danger')
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
      toast('实例已删除', 'ok')
      await afterSettingsChanged()
      this.syncDrafts()
      this.renderContent()
    } catch (error) {
      toast(error instanceof ApiError ? error.message : '删除失败', 'danger')
    } finally {
      this.saving = false
    }
  }

  // -------------------------------------------------------------------------
  // 人机校验
  // -------------------------------------------------------------------------

  private renderTurnstile(): void {
    const secretConfigured = this.settings?.turnstile.secret_configured ?? false
    const siteKeyConfigured = this.settings?.turnstile.site_key_configured ?? false

    replaceChildren(
      this.content,
      el(
        'div',
        { class: 'settings-section' },
        sectionTitle({
          icon: icons.shield,
          title: '人机校验',
          subtitle: 'CLOUDFLARE TURNSTILE',
        }),
        el(
          'div',
          { class: 'form-grid settings-form' },
          field(
            '站点公钥 Site Key',
            this.line(this.turnstileDraft.siteKey, (value) => {
              this.turnstileDraft.siteKey = value
            }, {
              type: 'password',
              placeholder: siteKeyConfigured ? '留空保持不变' : '0x4AAAAAAAA…',
            }),
          ),
          this.labeledField(
            '私钥 Secret Key',
            this.line(this.turnstileDraft.secretKey, (value) => {
              this.turnstileDraft.secretKey = value
            }, {
              type: 'password',
              placeholder: secretConfigured ? '留空保持不变' : '0x4AAAAAAAA…',
            }),
            this.configuredBadge(secretConfigured),
          ),
        ),
        el(
          'div',
          { class: 'toggle-list' },
          toggleRow({
            title: '启用人机校验',
            icon: icons.shield,
            checked: this.turnstileDraft.enabled,
            onChange: (checked) => {
              this.turnstileDraft.enabled = checked
            },
          }),
        ),
      ),
    )
  }

  private async saveTurnstile(): Promise<void> {
    if (this.saving) return

    const payload: TurnstileUpdate = { enabled: this.turnstileDraft.enabled }
    const siteKey = this.turnstileDraft.siteKey.trim()
    if (siteKey) payload.site_key = siteKey
    const secretKey = this.turnstileDraft.secretKey.trim()
    if (secretKey) payload.secret_key = secretKey

    await this.runSave(
      () => api.updateTurnstile(payload),
      '人机校验设置已保存',
      '保存人机校验设置失败',
    )
  }

  // -------------------------------------------------------------------------
  // Telegram
  // -------------------------------------------------------------------------

  private renderTelegram(): void {
    const tokenConfigured = this.settings?.telegram.token_configured ?? false
    const chatConfigured = this.settings?.telegram.chat_id_configured ?? false

    replaceChildren(
      this.content,
      el(
        'div',
        { class: 'settings-section' },
        sectionTitle({
          icon: icons.send,
          title: 'Telegram',
          subtitle: 'DELIVERY CHANNEL',
        }),
        el(
          'div',
          { class: 'form-grid settings-form' },
          this.labeledField(
            'Bot Token',
            this.line(this.telegramDraft.token, (value) => {
              this.telegramDraft.token = value
            }, {
              type: 'password',
              placeholder: tokenConfigured ? '留空保持不变' : '123456:AA…',
            }),
            this.configuredBadge(tokenConfigured),
          ),
          this.labeledField(
            'Chat ID',
            this.line(this.telegramDraft.chatId, (value) => {
              this.telegramDraft.chatId = value
            }, {
              type: 'password',
              placeholder: chatConfigured ? '留空保持不变' : '-1001234567890',
            }),
            this.configuredBadge(chatConfigured),
          ),
        ),
        el(
          'div',
          { class: 'toggle-list' },
          toggleRow({
            title: '启用 Telegram 通知',
            icon: icons.send,
            checked: this.telegramDraft.enabled,
            onChange: (checked) => {
              this.telegramDraft.enabled = checked
            },
          }),
        ),
        el(
          'div',
          { class: 'notification-action-row' },
          this.asyncButton('发送测试', icons.send, 'telegram', () =>
            testNotification('telegram'),
          ),
        ),
      ),
    )
  }

  private async saveTelegram(): Promise<void> {
    if (this.saving) return

    const payload: TelegramUpdate = {
      enabled: this.telegramDraft.enabled,
      chat_id: this.telegramDraft.chatId.trim(),
    }
    if (this.telegramDraft.token.trim()) {
      payload.token = this.telegramDraft.token.trim()
    }

    await this.runSave(
      () => api.updateTelegram(payload),
      'Telegram 配置已保存',
      '保存 Telegram 配置失败',
    )
  }

  // -------------------------------------------------------------------------
  // Bark
  // -------------------------------------------------------------------------

  private renderBark(): void {
    const configured = this.settings?.bark.device_key_configured ?? false

    const levelOptions: { value: PushLevel; label: string }[] = [
      { value: 'active', label: 'active（安静）' },
      { value: 'timeSensitive', label: 'timeSensitive（时效）' },
      { value: 'critical', label: 'critical（关键）' },
    ]

    replaceChildren(
      this.content,
      el(
        'div',
        { class: 'settings-section' },
        sectionTitle({ icon: icons.phone, title: 'Bark', subtitle: 'DELIVERY CHANNEL' }),
        el(
          'div',
          { class: 'form-grid settings-form' },
          field(
            'Server URL',
            this.line(this.barkDraft.serverUrl, (value) => {
              this.barkDraft.serverUrl = value
            }, { placeholder: 'https://api.day.app' }),
          ),
          this.labeledField(
            'Device Key',
            this.line(this.barkDraft.deviceKey, (value) => {
              this.barkDraft.deviceKey = value
            }, {
              type: 'password',
              placeholder: configured ? '留空保持不变' : '设备密钥',
            }),
            this.configuredBadge(configured),
          ),
          field(
            '普通通知级别',
            this.picker(this.barkDraft.normalLevel, levelOptions, (value) => {
              this.barkDraft.normalLevel = value
            }),
          ),
          field(
            '熔断告警级别',
            this.picker(this.barkDraft.alertLevel, levelOptions, (value) => {
              this.barkDraft.alertLevel = value
            }),
          ),
        ),
        el(
          'div',
          { class: 'toggle-list' },
          toggleRow({
            title: '启用 Bark 通知',
            icon: icons.phone,
            checked: this.barkDraft.enabled,
            onChange: (checked) => {
              this.barkDraft.enabled = checked
            },
          }),
        ),
        el(
          'div',
          { class: 'notification-action-row' },
          this.asyncButton('发送测试', icons.send, 'bark', () => testNotification('bark')),
        ),
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
    }
    if (this.barkDraft.deviceKey.trim()) {
      payload.device_key = this.barkDraft.deviceKey.trim()
    }

    await this.runSave(() => api.updateBark(payload), 'Bark 配置已保存', '保存 Bark 配置失败')
  }

  // -------------------------------------------------------------------------
  // 日报
  // -------------------------------------------------------------------------

  private renderReport(): void {
    replaceChildren(
      this.content,
      el(
        'div',
        { class: 'settings-section' },
        sectionTitle({ icon: icons.bell, title: '每日日报', subtitle: 'DAILY REPORT' }),
        el(
          'div',
          { class: 'form-grid settings-form' },
          field(
            '推送时间（按账号时区）',
            this.line(this.reportDraft.time, (value) => {
              this.reportDraft.time = value
            }, { placeholder: '09:00' }),
          ),
        ),
        el(
          'div',
          { class: 'toggle-list' },
          toggleRow({
            title: '启用每日日报推送',
            icon: icons.bell,
            checked: this.reportDraft.enabled,
            onChange: (checked) => {
              this.reportDraft.enabled = checked
            },
          }),
        ),
        el(
          'div',
          { class: 'notification-action-row' },
          this.asyncButton('立即推送一次', icons.bell, 'report', () => pushDailyReport()),
        ),
      ),
    )
  }

  private async saveReport(): Promise<void> {
    if (this.saving) return
    if (!/^\d{1,2}:\d{2}$/.test(this.reportDraft.time.trim())) {
      toast('日报时间格式应为 HH:MM', 'warn')
      return
    }
    await this.runSave(
      () => api.updateDailyReport(this.reportDraft.enabled, this.reportDraft.time.trim()),
      '日报设置已保存',
      '保存日报设置失败',
    )
  }

  // -------------------------------------------------------------------------
  // 系统
  // -------------------------------------------------------------------------

  private renderSystem(): void {
    const tzOptions = this.settings?.timezone_options ?? []
    const tzSelect = el('select', { class: 'native-select' }) as HTMLSelectElement
    for (const option of tzOptions) {
      tzSelect.append(el('option', { value: option.value, text: option.label }))
    }
    // 服务端返回的当前值若不在选项内（例如历史配置），补进去以免显示成第一项
    if (this.timezoneDraft && !tzOptions.some((o) => o.value === this.timezoneDraft)) {
      tzSelect.prepend(
        el('option', {
          value: this.timezoneDraft,
          text: `${this.timezoneDraft}（当前）`,
        }),
      )
    }
    tzSelect.value = this.timezoneDraft
    tzSelect.addEventListener('change', () => {
      this.timezoneDraft = tzSelect.value
    })

    replaceChildren(
      this.content,
      el(
        'div',
        { class: 'settings-section' },
        sectionTitle({ icon: icons.settings, title: '系统设置', subtitle: 'SYSTEM' }),
        el(
          'div',
          { class: 'form-grid settings-form' },
          field('系统时区', tzSelect),
          field(
            '日志级别',
            this.picker(
              this.advancedDraft.logLevel as 'error' | 'warn' | 'info' | 'debug',
              [
                { value: 'error', label: 'error · 仅错误' },
                { value: 'warn', label: 'warn · 含警告' },
                { value: 'info', label: 'info · 含流程' },
                { value: 'debug', label: 'debug' },
              ],
              (value) => {
                this.advancedDraft.logLevel = value
              },
            ),
          ),
          field(
            '任务锁窗口',
            this.numberLine(this.advancedDraft.jobLockMinutes, (value) => {
              this.advancedDraft.jobLockMinutes = value
            }, { min: '1', suffix: '分钟' }),
          ),
          field(
            '会话有效期',
            this.numberLine(this.advancedDraft.sessionDays, (value) => {
              this.advancedDraft.sessionDays = value
            }, { min: '1', suffix: '天' }),
          ),
        ),

        el(
          'div',
          { class: 'settings-divider' },
          el(
            'div',
            { class: 'section-title-row' },
            sectionTitle({ icon: icons.phone, title: '登录设备', subtitle: 'ACTIVE SESSIONS' }),
            el('button', {
              class: 'button button--secondary button--small',
              type: 'button',
              text: '刷新',
              on: { click: () => void this.loadDevices(true) },
            }),
          ),
          this.buildDeviceList(),
        ),
      ),
    )

    void this.loadDevices(false)
  }

  private async saveSystem(): Promise<void> {
    if (this.saving) return
    this.saving = true
    try {
      await api.updateTimezone(this.timezoneDraft.trim())
      await api.updateAdvanced({
        log_level: this.advancedDraft.logLevel,
        job_lock_ttl_ms: Math.round(this.advancedDraft.jobLockMinutes * 60_000),
        session_ttl_ms: Math.round(this.advancedDraft.sessionDays * 24 * 60 * 60 * 1000),
      })
      toast('系统设置已保存', 'ok')
      await afterSettingsChanged()
      this.syncDrafts()
      this.renderContent()
    } catch (error) {
      toast(error instanceof ApiError ? error.message : '保存失败', 'danger')
    } finally {
      this.saving = false
    }
  }

  /**
   * 登录设备列表。
   *
   * 返回一个稳定的容器：数据变化时只替换内部节点，避免重建整个设置页
   * 把正在展开的 `<select>` 一并销毁。
   */
  private buildDeviceList(): HTMLElement {
    if (!this.deviceListHost) {
      this.deviceListHost = el('div', { class: 'device-list' })
    }
    const wrapper = this.deviceListHost

    if (!this.devicesLoaded) {
      replaceChildren(wrapper, subtleEmpty('正在加载…', icons.spinner))
      return wrapper
    }
    if (this.devices.length === 0) {
      replaceChildren(wrapper, subtleEmpty('暂无登录设备', icons.phone))
      return wrapper
    }

    const nodes: HTMLElement[] = []
    const others = this.devices.filter((device) => !device.current)
    if (others.length > 0) {
      nodes.push(
        el(
          'div',
          { class: 'device-actions' },
          el('button', {
            class: 'button button--secondary button--small',
            type: 'button',
            text: '退出其它设备',
            on: { click: () => void this.kickOthers() },
          }),
        ),
      )
    }
    for (const device of this.devices) {
      nodes.push(this.buildDeviceRow(device))
    }

    replaceChildren(wrapper, ...nodes)
    return wrapper
  }

  private buildDeviceRow(device: SessionDevice): HTMLElement {
    const title = el('div', { class: 'device-row__title' })
    title.append(el('b', { text: deviceName(device.ua) }))
    if (device.current) title.append(el('span', { class: 'badge badge-ok', text: '本机' }))

    return el(
      'div',
      { class: 'device-row' },
      title,
      el('span', {
        text: `${device.ip || '未知来源'} · 登录于 ${formatTime(device.created_at)} · 最近活跃 ${relativeTime(device.last_seen_at)}`,
      }),
      ...(device.current
        ? []
        : [
            el('button', {
              class: 'button button--secondary button--small',
              type: 'button',
              text: this.kicking === device.sid ? '处理中…' : '下线',
              on: { click: () => void this.kickOne(device.sid) },
            }),
          ]),
    )
  }

  private refreshDeviceList(): void {
    if (this.activeTab === 'system') this.buildDeviceList()
  }

  private async loadDevices(notify: boolean): Promise<void> {
    try {
      const data = await api.sessions()
      this.devices = data.sessions
      this.devicesLoaded = true
      this.refreshDeviceList()
      if (notify) toast('设备列表已刷新', 'ok')
    } catch (error) {
      this.devicesLoaded = true
      this.refreshDeviceList()
      toast(error instanceof ApiError ? error.message : '读取登录设备失败', 'danger')
    }
  }

  private async kickOne(sid: string): Promise<void> {
    if (this.kicking) return
    this.kicking = sid
    try {
      const data = await api.revokeSession(sid)
      this.devices = data.sessions
      toast('该设备已下线', 'ok')
    } catch (error) {
      toast(error instanceof ApiError ? error.message : '下线失败', 'danger')
    } finally {
      this.kicking = null
      this.refreshDeviceList()
    }
  }

  private async kickOthers(): Promise<void> {
    if (this.kicking) return
    this.kicking = 'all'
    try {
      const data = await api.revokeOtherSessions()
      this.devices = data.sessions
      toast('其它设备已全部下线', 'ok')
    } catch (error) {
      toast(error instanceof ApiError ? error.message : '下线失败', 'danger')
    } finally {
      this.kicking = null
      this.refreshDeviceList()
    }
  }

  // -------------------------------------------------------------------------
  // 保存通用流程
  // -------------------------------------------------------------------------

  /**
   * 保存 → 提示 → 重新拉取设置 → 用服务端值重置草稿并重绘。
   *
   * 所有保存都走同一条路径：凭据字段保存后必须清空本地副本，
   * 避免「已保存的 Token 停留在输入框里」。
   */
  private async runSave(
    action: () => Promise<unknown>,
    successMessage: string,
    failureMessage: string,
  ): Promise<void> {
    if (this.saving) return
    this.saving = true
    this.paintSaving(true)
    try {
      await action()
      toast(successMessage, 'ok')
      await afterSettingsChanged()
      this.syncDrafts()
      this.renderContent()
    } catch (error) {
      toast(error instanceof ApiError ? error.message : failureMessage, 'danger')
    } finally {
      this.saving = false
      this.paintSaving(false)
    }
  }

  private paintSaving(busy: boolean): void {
    this.saveButton.disabled = busy
    replaceChildren(
      this.saveButton,
      iconSvg(busy ? icons.spinner : icons.check, 18, busy ? 'spin' : ''),
      el('span', { text: busy ? '保存中…' : '保存更改' }),
    )
  }
}
