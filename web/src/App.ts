/**
 * 主控制台外壳
 * ============================================================================
 * 页面结构：
 *
 *   app-shell
 *   ├ topbar         品牌 · 刷新/设置/日志/退出
 *   ├ metric-strip   四格汇总（共用一张卡，竖线分隔）
 *   ├ error-banner   概览拉取失败时的重试提示
 *   └ account-grid   账号卡片
 *
 * 渲染策略：外壳只构建一次，各区块通过 `update(state)` 增量刷新，
 * 避免每次轮询都重建整棵树（会丢失滚动位置与输入焦点）。
 */

import { api, type AccountOverview } from '@/api/client'
import type { AppState } from '@/lib/store'
import { clearToasts, store } from '@/lib/store'
import { brandLockup, el, iconButton, iconSvg, replaceChildren } from '@/lib/dom'
import { icons, type IconNode } from '@/lib/icons'
import { bootstrap, loadOverview, logout, refreshAll, reportError } from '@/lib/actions'
import { currentTheme, toggleTheme } from '@/lib/theme'
import { AccountList } from '@/components/AccountCard'
import { HistoryModal } from '@/components/HistoryModal'
import { LoginModal } from '@/components/LoginModal'
import { SettingsModal } from '@/components/SettingsModal'
import { renderToasts } from '@/components/ToastStack'

/** 每分钟读取概览，自动化动作写入的过渡态由后端按需补采。 */
const OVERVIEW_POLL_MS = 60_000

/**
 * 顶栏主题切换按钮。
 *
 * 图标按当前生效主题画：浅色时显示月亮（点了变深），深色时显示太阳。
 * 「跟随系统」仍只能在设置页里选，这里只做浅/深来回切。
 */
function themeButton(): HTMLButtonElement {
  const button = iconButton({
    label: '切换主题',
    icon: currentTheme() === 'dark' ? icons.sun : icons.moon,
    onClick: () => {
      const next = toggleTheme()
      const icon = button.querySelector('svg')
      if (icon) icon.replaceWith(iconSvg(next === 'dark' ? icons.sun : icons.moon, 18))
      button.dataset.tip = next === 'dark' ? '切换到浅色' : '切换到深色'
      button.setAttribute('aria-label', button.dataset.tip)
    },
  })
  button.dataset.tip = currentTheme() === 'dark' ? '切换到浅色' : '切换到深色'
  button.setAttribute('aria-label', button.dataset.tip)
  return button
}

/** 控制台外壳。 */
export class App {
  private readonly root: HTMLElement

  private shell: HTMLElement | null = null
  private loginModal: LoginModal | null = null
  private historyModal: HistoryModal | null = null
  private settingsModal: SettingsModal | null = null

  private readonly accountList = new AccountList(
    (accountId) => this.settingsModal?.open(store.get().settings, false, accountId),
    (account) => void this.openHistory(account),
  )

  private errorBanner: HTMLElement | null = null
  private metricStrip: HTMLElement | null = null
  private emptyCard: HTMLButtonElement | null = null
  private refreshButton: HTMLButtonElement | null = null
  private mobileMenuButton: HTMLButtonElement | null = null
  private menuOpen = false

  private pollTimer: number | null = null
  private pollInFlight = false
  private lastPhase: AppState['phase'] | null = null

  constructor(root: HTMLElement) {
    this.root = root
    store.subscribe((state) => this.onStateChange(state))
  }

  /** 启动应用。 */
  start(): void {
    void bootstrap()
    this.schedulePoll()

    document.addEventListener('visibilitychange', () => {
      if (this.pollTimer !== null) window.clearTimeout(this.pollTimer)
      this.pollTimer = null
      if (!document.hidden) void this.runPoll()
    })

    window.addEventListener('beforeunload', () => {
      if (this.pollTimer !== null) window.clearTimeout(this.pollTimer)
      clearToasts()
    })
  }

  /** 请求结束后安排下一次轮询，避免慢请求重叠。 */
  private schedulePoll(): void {
    if (this.pollTimer !== null) window.clearTimeout(this.pollTimer)
    this.pollTimer = null
    if (document.hidden) return

    this.pollTimer = window.setTimeout(() => {
      this.pollTimer = null
      void this.runPoll()
    }, OVERVIEW_POLL_MS)
  }

  private async runPoll(): Promise<void> {
    if (this.pollInFlight) return
    this.pollInFlight = true
    try {
      const state = store.get()
      if (!document.hidden && state.phase === 'ready' && !state.refreshingAll && !state.overviewLoading) {
        // 由后端当前快照决定是否补采，也能发现其它页面或 Cron 发起的动作。
        await loadOverview(true)
      }
    } finally {
      this.pollInFlight = false
      this.schedulePoll()
    }
  }

  // -------------------------------------------------------------------------
  // 状态分发
  // -------------------------------------------------------------------------

  private onStateChange(state: Readonly<AppState>): void {
    if (state.phase !== this.lastPhase) {
      this.lastPhase = state.phase
      this.switchPhase(state)
    } else if (state.phase === 'ready') {
      this.updateShell(state)
    }

    this.settingsModal?.update(state.settings)
    renderToasts([...state.toasts])
  }

  private switchPhase(state: Readonly<AppState>): void {
    this.loginModal?.dispose()
    this.loginModal = null
    this.teardownShell()

    if (state.phase === 'booting') {
      this.renderBooting()
      return
    }
    if (state.phase === 'unauthenticated') {
      this.renderLogin(state.session?.turnstile_site_key ?? '')
      return
    }
    this.renderShell(state)
  }

  // -------------------------------------------------------------------------
  // 启动中 / 登录
  // -------------------------------------------------------------------------

  private renderBooting(): void {
    replaceChildren(
      this.root,
      el(
        'div',
        { class: 'center-stage' },
        brandLockup(true),
        iconSvg(icons.spinner, 26, 'loading-glyph spin'),
      ),
    )
  }

  private renderLogin(siteKey: string): void {
    this.loginModal = new LoginModal(siteKey)
    replaceChildren(this.root, this.loginModal.element)
  }

  // -------------------------------------------------------------------------
  // 控制台装配
  // -------------------------------------------------------------------------

  /** 打开某账号的历史流量弹窗。数据按需拉取，不进 store。 */
  private async openHistory(account: AccountOverview): Promise<void> {
    if (!this.historyModal) return
    // 先开弹窗：图表模块与数据都在并行加载，用户立刻看到反馈而不是无响应
    this.historyModal.show(account.name)
    try {
      const data = await api.history(account.id)
      this.historyModal.open(account.name, data)
    } catch (error) {
      this.historyModal.close()
      reportError(error, '加载历史流量失败')
    }
  }

  private renderShell(state: Readonly<AppState>): void {
    this.settingsModal = new SettingsModal()
    this.historyModal = new HistoryModal()

    this.errorBanner = el('div', { class: 'error-banner', role: 'alert' })
    this.errorBanner.hidden = true

    this.metricStrip = el('section', { class: 'metric-strip' })

    this.emptyCard = el('button', {
      class: 'empty-state',
      type: 'button',
      on: { click: () => this.settingsModal?.open(store.get().settings, true) },
    }) as HTMLButtonElement
    replaceChildren(
      this.emptyCard,
      iconSvg(icons.cloud, 35),
      el('h3', { text: '添加第一个云端实例' }),
      el('p', { text: '进入设置完成 AccessKey 与实例信息配置' }),
      el(
        'span',
        {},
        el('span', { text: '打开设置' }),
        iconSvg(icons.chevronRight, 16),
      ),
    )
    this.emptyCard.hidden = true

    this.shell = el(
      'main',
      { class: 'app-shell' },
      this.buildTopbar(),
      this.errorBanner,
      this.metricStrip,
      this.accountList.element,
      this.emptyCard,
    )

    replaceChildren(
      this.root,
      this.shell,
      this.settingsModal.element,
      this.historyModal.element,
    )
    this.updateShell(state)
  }

  /** 顶栏：品牌 + 操作区。 */
  private buildTopbar(): HTMLElement {
    this.refreshButton = iconButton({
      label: '强制刷新全部实例',
      icon: icons.refresh,
      onClick: () => void refreshAll(),
    })

    const actions = el(
      'div',
      { class: 'topbar-actions', id: 'dashboard-actions' },
      this.refreshButton,
      themeButton(),
      iconButton({
        label: '设置',
        icon: icons.settings,
        onClick: () => this.openSettings(),
      }),
      iconButton({
        label: '退出登录',
        icon: icons.logout,
        onClick: () => void logout(),
      }),
    )

    this.mobileMenuButton = iconButton({
      label: '菜单',
      icon: icons.menu,
      className: 'mobile-menu',
      onClick: () => this.toggleMenu(),
    })

    return el(
      'header',
      { class: 'topbar' },
      brandLockup(),
      actions,
      this.mobileMenuButton,
    )
  }

  private toggleMenu(): void {
    this.menuOpen = !this.menuOpen
    const actions = this.shell?.querySelector('.topbar-actions')
    actions?.classList.toggle('open', this.menuOpen)
    if (this.mobileMenuButton) {
      this.mobileMenuButton.setAttribute('aria-expanded', String(this.menuOpen))
    }
  }

  private closeMenu(): void {
    if (!this.menuOpen) return
    this.menuOpen = false
    this.shell?.querySelector('.topbar-actions')?.classList.remove('open')
    this.mobileMenuButton?.setAttribute('aria-expanded', 'false')
  }

  private openSettings(startWithAdd = false): void {
    this.closeMenu()
    this.settingsModal?.open(store.get().settings, startWithAdd)
  }

  private updateShell(state: Readonly<AppState>): void {
    const overview = state.overview
    const accounts = overview?.accounts ?? []

    if (this.refreshButton) {
      this.refreshButton.disabled = state.refreshingAll || state.overviewLoading
    }

    this.renderErrorBanner(state)
    this.renderMetrics(accounts)
    this.renderEmptyState(state, accounts)
    this.accountList.render(accounts)
  }

  private renderErrorBanner(state: Readonly<AppState>): void {
    const banner = this.errorBanner
    if (!banner) return

    const hasError = state.overviewError.length > 0
    banner.hidden = !hasError
    if (!hasError) {
      banner.replaceChildren()
      return
    }

    replaceChildren(
      banner,
      iconSvg(icons.alert, 16),
      el('span', { text: state.overviewError }),
      el('button', {
        class: 'button button--secondary button--small',
        type: 'button',
        text: '重试',
        on: { click: () => void loadOverview() },
      }),
    )
  }

  /** 四格汇总。 */
  private renderMetrics(accounts: AccountOverview[]): void {
    if (!this.metricStrip) return

    let totalUsedGb = 0
    let running = 0
    let triggered = 0
    for (const account of accounts) {
      totalUsedGb += account.traffic_current ? account.traffic_used_gb : 0
      if (account.threshold_triggered) triggered += 1
      for (const instance of account.instances) {
        if (instance.status.toLowerCase() === 'running') running += 1
      }
    }

    const metric = (options: {
      icon: IconNode
      label: string
      value: string
      suffix: string
      tone: string
    }): HTMLElement =>
      el(
        'article',
        { class: `metric metric--${options.tone}` },
        el('span', { class: 'metric-icon' }, iconSvg(options.icon, 20)),
        el(
          'div',
          {},
          el('label', { text: options.label }),
          el(
            'strong',
            {},
            options.value,
            el('small', { text: options.suffix }),
          ),
        ),
      )

    replaceChildren(
      this.metricStrip,
      metric({
        icon: icons.server,
        label: '实例总数',
        value: String(accounts.length),
        suffix: '台',
        tone: 'blue',
      }),
      metric({
        icon: icons.activity,
        label: '运行中',
        value: String(running),
        suffix: '台',
        tone: 'green',
      }),
      metric({
        icon: icons.chart,
        label: '累计流量',
        value: totalUsedGb.toFixed(1),
        suffix: 'GB',
        tone: 'cyan',
      }),
      metric({
        icon: icons.alert,
        label: '阈值告警',
        value: String(triggered),
        suffix: '项',
        tone: triggered > 0 ? 'red' : 'amber',
      }),
    )
  }

  private renderEmptyState(state: Readonly<AppState>, accounts: AccountOverview[]): void {
    const card = this.emptyCard
    if (!card) return

    // overview 为 null 说明还没拿到过任何数据，此时显示空状态会误导用户
    const empty =
      state.phase === 'ready' &&
      state.overview !== null &&
      !state.overviewLoading &&
      accounts.length === 0
    card.hidden = !empty
  }

  // -------------------------------------------------------------------------
  // 清理
  // -------------------------------------------------------------------------

  private teardownShell(): void {
    this.historyModal?.dispose()
    this.historyModal = null
    this.settingsModal = null
    this.shell = null
    this.errorBanner = null
    this.metricStrip = null
    this.emptyCard = null
    this.refreshButton = null
    this.mobileMenuButton = null
    this.menuOpen = false
    clearToasts()
  }
}
