/**
 * 登录卡片
 * ============================================================================
 * 居中登录卡片 + Cloudflare Turnstile，布局照搬上游 `Login`：
 * 品牌锁定组 → 「ADMIN ACCESS / 欢迎回来 / 使用管理员凭据进入控制台」
 * → 字段 → 主按钮。
 *
 * Turnstile 使用 `appearance: 'interaction-only'`：静默验证通过时卡片上
 * 不出现任何人机校验痕迹，仅在 Cloudflare 判定可疑时原地展开复选框。
 *
 * 三个约束：
 *
 * 1. 脚本以 `render=explicit` 异步加载，需轮询等待 `window.turnstile` 就绪；
 * 2. token 一次性，提交失败后必须 `reset()`；
 * 3. 销毁时必须 `remove()`，否则反复进出登录页会泄漏 widget。
 *
 * 提交按钮不等待 token：静默校验的完成时机不可控，按钮只要求「已填密码
 * 且未在提交中」。token 在提交瞬间读取（`getResponse()` 兜底），尚未就绪
 * 则提示用户稍候重试。
 */

import { api, ApiError } from '@/api/client'
import {
  brandLockup,
  el,
  eyebrow,
  field,
  iconSvg,
  inputShell,
  replaceChildren,
  textInput,
} from '@/lib/dom'
import { icons } from '@/lib/icons'
import { afterLogin } from '@/lib/actions'
import { store } from '@/lib/store'

const TURNSTILE_SCRIPT_TIMEOUT_MS = 10_000

/** 登录卡片组件。 */
export class LoginModal {
  readonly element: HTMLElement

  private readonly card: HTMLFormElement
  private readonly usernameInput: HTMLInputElement
  private readonly passwordInput: HTMLInputElement
  private readonly submitButton: HTMLButtonElement
  private readonly widgetHost: HTMLDivElement
  private readonly errorBox: HTMLDivElement

  private widgetId: string | null = null
  private token = ''
  private submitting = false
  private disposed = false
  private pollTimer: number | null = null

  constructor(private readonly siteKey: string) {
    this.usernameInput = textInput({
      type: 'text',
      id: 'admin-username',
      placeholder: '管理员用户名',
      autocomplete: 'username',
      spellcheck: false,
    })

    this.passwordInput = el('input', {
      type: 'password',
      id: 'admin-password',
      placeholder: '请输入管理员密码',
      autocomplete: 'current-password',
    }) as HTMLInputElement

    this.submitButton = el(
      'button',
      { class: 'button button--primary button--full', type: 'submit' },
      el('span', { text: '安全登录' }),
    ) as HTMLButtonElement

    this.widgetHost = el('div', { class: 'cf-turnstile' })

    this.errorBox = el('div', { class: 'inline-error', role: 'alert' })
    this.errorBox.hidden = true

    this.card = el(
      'form',
      {
        class: 'glass-card auth-card',
        on: {
          submit: (event) => {
            event.preventDefault()
            void this.submit()
          },
        },
      },
      el('div', { class: 'large-icon' }, iconSvg(icons.shield, 28)),
      eyebrow('ADMIN ACCESS'),
      el('h1', { text: '欢迎回来' }),
      el('p', { class: 'muted', text: '使用管理员凭据进入控制台' }),
      el(
        'div',
        { class: 'form-stack' },
        field('管理员用户名', inputShell({ icon: icons.cloud, input: this.usernameInput })),
        field('管理员密码', inputShell({ icon: icons.key, input: this.passwordInput })),
        this.buildTurnstileSection(),
      ),
      this.errorBox,
      this.submitButton,
    )

    this.element = el(
      'main',
      { class: 'login-shell' },
      el(
        'div',
        { class: 'login-card-stack' },
        el(
          'div',
          { class: 'login-brand' },
          brandLockup(true),
          el('p', { text: '阿里云 CDT 流量与实例自动化控制台' }),
        ),
        this.card,
      ),
    )

    this.usernameInput.addEventListener('input', () => this.syncSubmitState())
    this.passwordInput.addEventListener('input', () => this.syncSubmitState())

    if (this.siteKey.trim()) {
      void this.renderWidget()
    }
  }

  /**
   * Turnstile 区域。
   *
   * 容器始终留在 DOM 中且不手动设置 `display`：`appearance: 'interaction-only'`
   * 已保证无交互需求时不渲染可见内容。被 `display: none` 隐藏的容器内
   * Turnstile 不会执行校验，token 无法获取。
   */
  private buildTurnstileSection(): HTMLElement {
    if (!this.siteKey.trim()) {
      // 后台没启用 Turnstile（默认状态）：什么都不渲染，卡片保持干净。
      return el('div', { hidden: true, dataset: { role: 'turnstile-off' } })
    }
    return el('div', { dataset: { role: 'turnstile-section' } }, this.widgetHost)
  }

  /** 等待 Turnstile 脚本加载完成。 */
  private waitForTurnstile(): Promise<boolean> {
    if (window.turnstile) return Promise.resolve(true)

    return new Promise((resolve) => {
      const deadline = Date.now() + TURNSTILE_SCRIPT_TIMEOUT_MS
      this.pollTimer = window.setInterval(() => {
        if (window.turnstile) {
          this.stopPolling()
          resolve(true)
          return
        }
        if (Date.now() > deadline || this.disposed) {
          this.stopPolling()
          resolve(false)
        }
      }, 120)
    })
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  /** 渲染小组件。 */
  private async renderWidget(): Promise<void> {
    const ready = await this.waitForTurnstile()
    if (this.disposed) return

    if (!ready || !window.turnstile) {
      this.showError('人机校验组件加载失败，请刷新页面重试')
      return
    }

    if (this.widgetId !== null) return

    this.widgetId = window.turnstile.render(this.widgetHost, {
      sitekey: this.siteKey,
      theme: 'light',
      size: 'flexible',
      language: 'zh-CN',
      // 关键：默认不显示，仅在需要人工交互时才展开复选框
      appearance: 'interaction-only',
      // 校验通过后不再自动刷新过期令牌（登录是一次性动作）
      'refresh-expired': 'manual',

      callback: (token: string) => {
        this.token = token
        this.hideError()
        this.syncSubmitState()
      },

      'expired-callback': () => {
        this.token = ''
        this.syncSubmitState()
      },

      'error-callback': () => {
        this.token = ''
        this.syncSubmitState()
        this.showError('人机校验出错，请重试')
      },

      'timeout-callback': () => {
        this.token = ''
        this.syncSubmitState()
      },

      'unsupported-callback': () => {
        this.showError('当前浏览器不支持人机校验组件，请更换浏览器后重试')
      },
    })
  }

  /** 重置小组件（token 一次性，失败后必须重置）。 */
  private resetWidget(): void {
    this.token = ''
    if (this.widgetId !== null && window.turnstile) {
      window.turnstile.reset(this.widgetId)
    }
    this.syncSubmitState()
  }

  /**
   * 读取当前 token。
   *
   * `interaction-only` 下静默校验通过时，`callback` 会带上 token；
   * 极少数情况下内部状态已就绪而本地变量还是空，此时用 `getResponse()` 兜底。
   */
  private currentToken(): string {
    if (this.token) return this.token
    if (this.widgetId !== null && window.turnstile) {
      try {
        const token = window.turnstile.getResponse(this.widgetId)
        if (token) this.token = token
        return token ?? ''
      } catch {
        return ''
      }
    }
    return ''
  }

  /**
   * 同步按钮可用性。
   *
   * 不要求 token 非空：`interaction-only` 下的静默校验由 Cloudflare
   * 异步完成，耗时不可预期，等待 token 会造成按钮长时间不可点。
   */
  private syncSubmitState(): void {
    const ready = !this.submitting && this.passwordInput.value.length > 0
    this.submitButton.disabled = !ready

    replaceChildren(
      this.submitButton,
      ...(this.submitting
        ? [iconSvg(icons.spinner, 18, 'spin'), el('span', { text: '验证中…' })]
        : [iconSvg(icons.arrowRight, 18), el('span', { text: '安全登录' })]),
    )
  }

  private showError(message: string): void {
    this.errorBox.hidden = false
    replaceChildren(
      this.errorBox,
      iconSvg(icons.alert, 16),
      el('span', { text: message }),
    )
  }

  private hideError(): void {
    this.errorBox.hidden = true
    this.errorBox.replaceChildren()
  }

  /** 提交登录。 */
  private async submit(): Promise<void> {
    if (this.submitting) return
    if (!this.passwordInput.value) return

    const token = this.currentToken()
    if (this.siteKey.trim() && !token) {
      this.showError('人机校验尚未完成，请稍候重试')
      return
    }

    this.submitting = true
    this.syncSubmitState()
    this.hideError()

    try {
      const session = await api.login(
        this.usernameInput.value.trim(),
        this.passwordInput.value,
        token,
      )
      store.patch({ session })
      this.passwordInput.value = ''
      this.usernameInput.value = ''
      this.token = ''
      await afterLogin()
    } catch (error) {
      this.showError(error instanceof ApiError ? error.message : '登录失败，请稍后重试')
      // token 已被消费，必须重新获取
      this.resetWidget()
    } finally {
      this.submitting = false
      this.syncSubmitState()
    }
  }

  /** 卸载时移除 widget 与定时器。 */
  dispose(): void {
    this.disposed = true
    this.stopPolling()
    if (this.widgetId !== null && window.turnstile) {
      window.turnstile.remove(this.widgetId)
      this.widgetId = null
    }
  }
}
