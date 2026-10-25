/// <reference types="vite/client" />

/**
 * Cloudflare Turnstile 全局对象声明。
 * 通过 index.html 里的 api.js?render=explicit 注入。
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
   * * `interaction-only`  —— **只在需要用户交互时显示**，通过校验后自动消失
   *
   * 本项目使用 `interaction-only`：绝大多数访问者无感通过，只有被判定
   * 可疑时才弹出复选框。
   */
  appearance?: TurnstileAppearance
  /** 执行模式为 `execute` 时必须手动调用；否则由浏览器自动触发。 */
  execution?: 'render' | 'execute'
  /** 校验通过后自动隐藏（`interaction-only` 下默认即如此，显式声明更清楚）。 */
  retry?: 'auto' | 'never'
  'refresh-expired'?: 'auto' | 'manual' | 'never'
  callback?: (token: string) => void
  'expired-callback'?: () => void
  'error-callback'?: (code: string) => void
  'timeout-callback'?: () => void
  /** 开始/结束交互时通知（用于同步按钮状态）。 */
  'before-interactive-callback'?: () => void
  'after-interactive-callback'?: () => void
  /** `interaction-only` 下自动通过时也会触发，用于隐藏占位容器。 */
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
    /** 脚本加载完成回调（script 上挂 onload 更可靠，这里作为兜底）。 */
    onloadTurnstileCallback?: () => void
  }
}

export {}
