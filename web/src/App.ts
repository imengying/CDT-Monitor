/**
 * 主控制台（对应原版 `App.vue`）
 * ============================================================================
 * 负责整体布局与各区块的装配：
 *
 *   ┌ 顶部导航：标题 · 刷新 · 日志 · 设置 · 退出 ┐
 *   ├ 汇总条：账号 / 本月流量 / 实例 / 熔断                   ┤
 *   ├ 账号卡片区（AccountList）                                ┤
 *   └ 历史流量弹窗（HistoryModal，由卡片上的按钮打开）              ┘
 *
 * 渲染策略：外壳只构建一次，各区块通过 `update(state)` 增量刷新，
 * 避免每次 60 秒轮询都重建整棵树（会丢失滚动位置与输入焦点）。
 */

import { api, type AccountOverview } from '@/api/client'
import type { AppState } from '@/lib/store'
import { clearToasts, store } from '@/lib/store'
import { el, iconSvg, replaceChildren } from '@/lib/dom'
import { icons } from '@/lib/icons'
import {
  bootstrap,
  loadOverview,
  logout,
  refreshAll,
  reportError,
} from '@/lib/actions'
import { AccountList } from '@/components/AccountCard'
import { HistoryModal } from '@/components/HistoryModal'
import { LoginModal } from '@/components/LoginModal'
import { LogDrawer } from '@/components/LogDrawer'
import { SettingsModal } from '@/components/SettingsModal'
import { renderToasts } from '@/components/ToastStack'

/**
 * 概览静默轮询间隔（毫秒）。
 *
 * 数据实际由 Cron 每 15 分钟写一次，轮询比它更勤只会白烧请求，
 * 因此取 5 分钟，保证刷新后能较快看到新数据即可。
 */
const OVERVIEW_POLL_MS = 5 * 60_000

/** 控制台外壳。 */
export class App {
  private readonly root: HTMLElement

  private shell: HTMLElement | null = null
  private loginModal: LoginModal | null = null
  private historyModal: HistoryModal | null = null
  private settingsModal: SettingsModal | null = null
  private logDrawer: LogDrawer | null = null

  private readonly accountList = new AccountList(
    (accountId) => this.settingsModal?.open(store.get().settings, false, accountId),
    (account) => void this.openHistory(account),
  )

  /** 需要就地更新的节点。 */
  private refreshButton: HTMLButtonElement | null = null
  private errorBanner: HTMLDivElement | null = null
  private summaryGrid: HTMLElement | null = null
  private emptyCard: HTMLElement | null = null

  private pollTimer: number | null = null
  private lastPhase: AppState['phase'] | null = null

  constructor(root: HTMLElement) {
    this.root = root
    store.subscribe((state) => this.onStateChange(state))
  }

  /** 启动应用。 */
  start(): void {
    void bootstrap()

    this.pollTimer = window.setInterval(() => {
      const state = store.get()
      if (state.phase === 'ready' && !state.refreshingAll && !state.overviewLoading) {
        void loadOverview()
      }
    }, OVERVIEW_POLL_MS)

    window.addEventListener('beforeunload', () => {
      if (this.pollTimer !== null) window.clearInterval(this.pollTimer)
      clearToasts()
    })
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
        {
          class: 'flex min-h-full items-center justify-center',
          style: { color: 'var(--color-ink-subtle)' },
        },
        el(
          'div',
          { class: 'flex flex-col items-center gap-3' },
          iconSvg(icons.spinner, 20, 'animate-spin'),
          el('span', { class: 'text-xs', text: '正在加载控制台…' }),
        ),
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
    try {
      const data = await api.history(account.id)
      this.historyModal.open(account.name, data)
    } catch (error) {
      reportError(error, '加载历史流量失败')
    }
  }

  private renderShell(state: Readonly<AppState>): void {
    this.settingsModal = new SettingsModal()
    this.logDrawer = new LogDrawer()
    this.historyModal = new HistoryModal()

    this.refreshButton = el('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      title: '刷新全部账号',
      on: { click: () => void refreshAll() },
    }) as HTMLButtonElement

    this.errorBanner = el('div', {
      class: 'mb-3 hidden items-start gap-2 rounded-lg px-3 py-2 text-xs',
      style: {
        backgroundColor: 'var(--color-danger-soft)',
        color: 'var(--color-danger)',
      },
    })

    // 汇总条：四格等分，共用一张卡片
    this.summaryGrid = el('section', {
      class: 'card mb-4 grid overflow-hidden grid-cols-2 sm:grid-cols-4',
    })

    this.emptyCard = this.buildEmptyCard()

    this.shell = el(
      'div',
      { class: 'min-h-full' },
      this.buildHeader(),
      el(
        'main',
        { class: 'mx-auto max-w-7xl px-5 py-5' },
        this.errorBanner,
        this.summaryGrid,
        this.emptyCard,
        this.accountList.element,
      ),
    )

    replaceChildren(
      this.root,
      this.shell,
      this.settingsModal.element,
      this.logDrawer.element,
      this.historyModal.element,
    )
    this.updateShell(state)
  }

  private buildHeader(): HTMLElement {
    const barButton = (
      label: string,
      icon: typeof icons.activity,
      title: string,
      onClick: () => void,
    ): HTMLButtonElement =>
      el(
        'button',
        { class: 'btn btn-ghost', type: 'button', title, on: { click: onClick } },
        iconSvg(icon, 15),
        ...(label ? [el('span', { class: 'hidden sm:inline', text: label })] : []),
      ) as HTMLButtonElement

    return el(
      'header',
      {
        class: 'sticky top-0 z-30 border-b',
        style: {
          borderColor: 'var(--color-line)',
          backgroundColor: 'var(--color-surface)',
        },
      },
      el(
        'div',
        { class: 'mx-auto flex max-w-7xl items-center gap-3 px-5 py-3' },
        el(
          'div',
          { class: 'flex min-w-0 items-center gap-2.5' },
          el(
            'div',
            {
              class: 'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white',
              style: { background: 'linear-gradient(135deg, #2563eb, #0ea5e9)' },
            },
            iconSvg(icons.cloud, 16),
          ),
          el(
            'div',
            { class: 'min-w-0' },
            el('h1', { class: 'truncate text-base leading-tight font-semibold', text: 'CDT Monitor' }),
          ),
        ),
        el('div', { class: 'flex-1' }),
        el(
          'div',
          { class: 'flex items-center gap-1.5' },
          this.refreshButton,
          barButton('日志', icons.activity, '操作日志', () => this.logDrawer?.open()),
          barButton('设置', icons.settings, '系统设置', () =>
            this.settingsModal?.open(store.get().settings),
          ),
          barButton('', icons.logout, '退出登录', () => void logout()),
        ),
      ),
    )
  }

  private buildEmptyCard(): HTMLElement {
    const card = el('div', {
      class: 'card flex-col items-center justify-center gap-3 px-6 py-14 text-center',
    })
    replaceChildren(
      card,
      el(
        'div',
        {
          class: 'flex h-12 w-12 items-center justify-center rounded-2xl',
          style: {
            backgroundColor: 'var(--color-brand-soft)',
            color: 'var(--color-brand)',
          },
        },
        iconSvg(icons.dashboard, 22),
      ),
      el(
        'div',
        {},
        el('h2', { class: 'text-sm font-semibold', text: '还没有阿里云账号' }),
        el('p', {
          class: 'mt-1 text-xs',
          style: { color: 'var(--color-ink-subtle)' },
          text: '添加阿里云账号后开始监控。',
        }),
      ),
      el(
        'button',
        {
          class: 'btn btn-primary',
          type: 'button',
          on: { click: () => this.settingsModal?.open(store.get().settings, true) },
        },
        iconSvg(icons.plus, 13),
        el('span', { text: '添加账号' }),
      ),
    )
    card.classList.add('hidden')
    return card
  }

  private updateShell(state: Readonly<AppState>): void {
    const overview = state.overview
    const accounts = overview?.accounts ?? []


    if (this.refreshButton) {
      this.refreshButton.disabled = state.refreshingAll
      replaceChildren(
        this.refreshButton,
        ...(state.refreshingAll
          ? [iconSvg(icons.spinner, 13, 'animate-spin')]
          : [iconSvg(icons.refresh, 13)]),
        el('span', { class: 'hidden sm:inline', text: '刷新' }),
      )
    }

    this.renderErrorBanner(state)
    this.renderSummary(accounts)
    this.renderEmptyState(state, accounts)
    this.accountList.render(accounts)
  }

  private renderErrorBanner(state: Readonly<AppState>): void {
    const banner = this.errorBanner
    if (!banner) return

    const hasError = state.overviewError.length > 0
    banner.classList.toggle('hidden', !hasError)
    banner.classList.toggle('flex', hasError)

    if (!hasError) {
      banner.replaceChildren()
      return
    }

    replaceChildren(
      banner,
      iconSvg(icons.alert, 14),
      el('span', { class: 'flex-1 leading-relaxed', text: state.overviewError }),
      el('button', {
        class: 'btn btn-ghost btn-sm',
        type: 'button',
        text: '重试',
        on: { click: () => void loadOverview() },
      }),
    )
  }

  private renderSummary(accounts: AccountOverview[]): void {
    if (!this.summaryGrid) return

    let totalUsedGb = 0
    let running = 0
    let stopped = 0
    let triggered = 0
    let enabled = 0
    for (const account of accounts) {
      totalUsedGb += account.traffic_used_gb
      if (account.enabled) enabled += 1
      if (account.threshold_triggered) triggered += 1
      for (const instance of account.instances) {
        const status = instance.status.toLowerCase()
        if (status === 'running') running += 1
        else if (status === 'stopped') stopped += 1
      }
    }

    const metric = (
      label: string,
      value: string,
      hint: string,
      icon: typeof icons.dashboard,
      tone: 'brand' | 'ok' | 'warn' | 'danger' | 'muted',
    ): HTMLElement => {
      const toneMap = {
        brand: ['var(--color-brand)', 'var(--color-brand-soft)'],
        ok: ['var(--color-ok)', 'var(--color-ok-soft)'],
        warn: ['var(--color-warn)', 'var(--color-warn-soft)'],
        danger: ['var(--color-danger)', 'var(--color-danger-soft)'],
        muted: ['var(--color-ink-muted)', 'var(--color-surface-muted)'],
      } as const
      const [fg, bg] = toneMap[tone]
      return el(
        'div',
        {
          class: 'flex items-center gap-3 px-4 py-3',
        },
        el(
          'div',
          {
            class: 'grid shrink-0 place-items-center rounded-lg',
            style: { width: '36px', height: '36px', color: fg, backgroundColor: bg },
          },
          iconSvg(icon, 17),
        ),
        el(
          'div',
          { class: 'min-w-0' },
          el('label', {
            class: 'mb-1 block text-xs font-medium',
            style: { color: 'var(--color-ink-muted)' },
            text: label,
          }),
          el(
            'div',
            { class: 'flex items-baseline' },
            el('strong', {
              class: 'text-lg font-semibold tabular-nums',
              style: { color: fg },
              text: value,
            }),
            el('small', {
              class: 'ml-1 text-xs',
              style: { color: 'var(--color-ink-subtle)' },
              text: hint,
            }),
          ),
        ),
      )
    }

    replaceChildren(
      this.summaryGrid,
      metric('账号', `${enabled}`, `/ ${accounts.length}`, icons.server, 'brand'),
      metric('本月流量', totalUsedGb.toFixed(1), 'GB', icons.chart, 'brand'),
      metric('实例', `${running}`, `运行 / ${stopped} 停止`, icons.serverCog, 'ok'),
      metric(
        '熔断',
        String(triggered),
        triggered > 0 ? '已禁止拉起' : '正常',
        icons.shield,
        triggered > 0 ? 'danger' : 'muted',
      ),
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
    card.classList.toggle('hidden', !empty)
    card.classList.toggle('flex', empty)
  }

  // -------------------------------------------------------------------------
  // 清理
  // -------------------------------------------------------------------------

  private teardownShell(): void {
    this.historyModal?.dispose()
    this.historyModal = null
    this.settingsModal = null
    this.logDrawer = null
    this.shell = null
    this.refreshButton = null
    this.errorBanner = null
    this.summaryGrid = null
    this.emptyCard = null
    clearToasts()
  }
}
