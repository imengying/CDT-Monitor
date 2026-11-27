/// <reference types="vite/client" />

/**
 * Cloudflare Turnstile 全局对象声明。
 * 应用入口通过 `api.js?render=explicit` 异步加载，组件共享同一个 Promise。
 */

/** Turnstile 执行模式。 */
type TurnstileAppearance = 'always' | 'execute' | 'interaction-only'

interface TurnstileRenderOptions {
  sitekey: string
  theme?: 'light' | 'dark' | 'auto'
  size?: 'normal' | 'compact' | 'flexible'
  language?: string
  /**
   * 显示策略：
   * * `always`            —— 始终显示（默认）
   * * `execute`           —— 不显示，`execute()` 之后才跑
   * * `interaction-only`  —— 只在需要用户交互时显示，通过校验后自动消失
   *
   * 本项目使用 `always`：与 NodeFlare 一致，组件立即显示并执行，通过后隐藏。
   */
  appearance?: TurnstileAppearance
  /** 执行模式为 `execute` 时必须手动调用；否则由浏览器自动触发。 */
  execution?: 'render' | 'execute'
  /** 重试策略（默认自动重试）。 */
  retry?: 'auto' | 'never'
  'refresh-expired'?: 'auto' | 'manual' | 'never'
  callback?: (token: string) => void
  'expired-callback'?: () => void
  'error-callback'?: (code: string) => void
  'timeout-callback'?: () => void
  /** 浏览器不支持时给出明确提示。 */
  'unsupported-callback'?: () => void
}

interface TurnstileApi {
  render(container: string | HTMLElement, options: TurnstileRenderOptions): string
  reset(widgetId?: string): void
  remove(widgetId: string): void
  /** 仅 `execution: 'execute'` 时需要。 */
  execute(container: string | HTMLElement): void
  /** 立即获取当前 token（可能为空）。 */
  getResponse(widgetId?: string): string
  isExpired(widgetId?: string): boolean
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

export {}
