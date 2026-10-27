/**
 * 全局状态与订阅
 * ============================================================================
 * 一个极小的「可观察状态」：组件订阅它，动作函数修改它。
 *
 * 为什么不用 Proxy 做响应式：
 * 控制台每次更新都是「整块数据换掉」（概览 / 设置 / 图表），
 * 粗粒度订阅反而更可控，也避免深层代理的性能与调试成本。
 */

import type {
  OverviewResponse,
  SessionResponse,
  SettingsResponse,
} from '@/api/client'

export type Phase = 'booting' | 'unauthenticated' | 'ready'

export type ToastTone = 'ok' | 'danger' | 'warn'

export interface Toast {
  id: number
  text: string
  tone: ToastTone
}

export interface AppState {
  phase: Phase
  session: SessionResponse | null

  overview: OverviewResponse | null
  overviewLoading: boolean
  overviewError: string
  refreshingAll: boolean

  settings: SettingsResponse | null



  toasts: Toast[]
}

/** 初始状态。 */
function initialState(): AppState {
  return {
    phase: 'booting',
    session: null,
    overview: null,
    overviewLoading: false,
    overviewError: '',
    refreshingAll: false,
    settings: null,
    toasts: [],
  }
}

type Listener = (state: Readonly<AppState>) => void

/** 状态容器。 */
export class Store {
  private state: AppState = initialState()
  private listeners = new Set<Listener>()

  /** 读取当前状态（只读快照）。 */
  get(): Readonly<AppState> {
    return this.state
  }

  /** 局部更新并通知订阅者。 */
  patch(partial: Partial<AppState>): void {
    this.state = { ...this.state, ...partial }
    this.emit()
  }

  /**
   * 用 updater 更新，适合基于旧值计算新值。
   * 返回 `null` 表示「无变化」，跳过通知（避免无谓重渲染）。
   */
  update(updater: (current: Readonly<AppState>) => Partial<AppState> | null): void {
    const partial = updater(this.state)
    if (partial === null) return
    this.patch(partial)
  }

  /** 订阅状态变化，返回解绑函数。 */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.state)
    }
  }
}

/** 全局单例。 */
export const store = new Store()

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

let toastSeed = 0
const toastTimers = new Map<number, number>()

/** 弹出一条 toast，到期自动消失。 */
export function toast(text: string, tone: ToastTone = 'ok', durationMs = 4200): number {
  const id = ++toastSeed
  const next = [...store.get().toasts, { id, text, tone }]
  store.patch({ toasts: next })

  const timer = window.setTimeout(() => dismissToast(id), durationMs)
  toastTimers.set(id, timer)
  return id
}

/** 关闭指定 toast。 */
export function dismissToast(id: number): void {
  const timer = toastTimers.get(id)
  if (timer !== undefined) {
    window.clearTimeout(timer)
    toastTimers.delete(id)
  }
  const next = store.get().toasts.filter((item) => item.id !== id)
  if (next.length !== store.get().toasts.length) {
    store.patch({ toasts: next })
  }
}

/** 清理全部 toast（页面卸载时用）。 */
export function clearToasts(): void {
  for (const timer of toastTimers.values()) {
    window.clearTimeout(timer)
  }
  toastTimers.clear()
  store.patch({ toasts: [] })
}
