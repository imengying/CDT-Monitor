/**
 * 登录卡片
 * ============================================================================
 * 居中登录卡片 + Cloudflare Turnstile，布局照搬上游 `Login`：
 * 品牌锁定组 → 「ADMIN ACCESS / 欢迎回来 / 使用管理员凭据进入控制台」
 * → 字段 → 主按钮。
 *
 * Turnstile 与 NodeFlare 一致使用默认显示模式：登录页出现后立刻执行，
 * 校验成功后收起组件；需要人工交互时可以直接看到复选框。
 *
 * 三个约束：
 *
 * 1. 应用启动即加载脚本，组件共享同一个加载 Promise，避免重复插入；
 * 2. token 一次性，提交失败后必须 `reset()`；
 * 3. 销毁时必须 `remove()`，否则反复进出登录页会泄漏 widget。
 *
 * 提交按钮不等待 token：静默校验的完成时机不可控，按钮只要求「已填密码
 * 且未在提交中」。token 在提交瞬间读取（`getResponse()` 兜底），尚未就绪
 * 则提示用户稍候重试。
 */

import { api, ApiError } from '@/api/client'
import {
  el,
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
const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

let scriptPromise: Promise<void> | null = null

/** 应用启动即加载；登录组件复用同一 Promise，不轮询、不重复插入脚本。 */
export function preloadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve()
  if (scriptPromise) return scriptPromise

  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    const finish = (error?: Error): void => {
      window.clearTimeout(timeout)
      if (error) {
        script.remove()
        scriptPromise = null
        reject(error)
      } else {
        resolve()
      }
    }
    const timeout = window.setTimeout(
      () => finish(new Error('Cloudflare Turnstile 加载超时')),
      TURNSTILE_SCRIPT_TIMEOUT_MS,
    )

    script.src = TURNSTILE_SCRIPT_URL
    script.async = true
    script.defer = true
    script.onload = () => finish()
    script.onerror = () => finish(new Error('Cloudflare Turnstile 加载失败'))
    document.head.appendChild(script)
  })
  return scriptPromise
}

/** 登录卡片组件。 */
export class LoginModal {
  readonly element: HTMLElement

  private readonly card: HTMLFormElement
  private readonly usernameInput: HTMLInputElement
  private readonly passwordInput: HTMLInputElement
  private readonly submitButton: HTMLButtonElement
  private readonly widgetHost: HTMLDivElement
  private readonly widgetSection: HTMLElement
  private readonly errorBox: HTMLDivElement

  private widgetId: string | null = null
  private token = ''
  private submitting = false
  private disposed = false
  private renderStarted = false

  constructor(private siteKey: string) {
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
      el('span', { text: '登录' }),
    ) as HTMLButtonElement

    this.widgetHost = el('div', { class: 'cf-turnstile' })
    this.widgetSection = this.buildTurnstileSection()

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
      el('h1', { text: '欢迎回来' }),
      el('p', { class: 'muted', text: '使用管理员凭据进入控制台' }),
      el(
        'div',
        { class: 'form-stack' },
        field('管理员用户名', inputShell({ icon: icons.cloud, input: this.usernameInput })),
        field('管理员密码', inputShell({ icon: icons.key, input: this.passwordInput })),
        this.widgetSection,
      ),
      this.errorBox,
      this.submitButton,
    )

    this.element = el(
      'main',
      { class: 'login-shell' },
      el('div', { class: 'login-card-stack' }, this.card),
    )

    this.usernameInput.addEventListener('input', () => this.syncSubmitState())
    this.passwordInput.addEventListener('input', () => this.syncSubmitState())

    if (this.siteKey.trim()) {
      void this.renderWidget()
    }
  }

  /**
   * 组件立即渲染，校验通过后再隐藏，避免用户以为页面卡住。
   * 未启用时保留一个隐藏节点，表单结构保持一致。
   */
  private buildTurnstileSection(): HTMLElement {
    return el(
      'div',
      {
        hidden: !this.siteKey.trim(),
        dataset: { role: this.siteKey.trim() ? 'turnstile-section' : 'turnstile-off' },
      },
      this.widgetHost,
    )
  }

  /** 会话接口返回后启用组件，不重建表单，也不打断用户输入。 */
  configure(siteKey: string): void {
    if (this.disposed || this.siteKey.trim() || !siteKey.trim()) return
    this.siteKey = siteKey
    this.widgetSection.dataset.role = 'turnstile-section'
    this.widgetSection.hidden = false
    void this.renderWidget()
  }

  /** 渲染小组件。 */
  private async renderWidget(): Promise<void> {
    if (this.renderStarted || this.disposed || !this.siteKey.trim()) return
    this.renderStarted = true
    try {
      await preloadTurnstileScript()
    } catch {
      if (!this.disposed) this.showError('人机校验组件加载失败，请刷新页面重试')
      return
    }
    if (this.disposed) return

    if (!window.turnstile) {
      this.showError('人机校验组件加载失败，请刷新页面重试')
      return
    }

    if (this.widgetId !== null) return

    this.widgetId = window.turnstile.render(this.widgetHost, {
      sitekey: this.siteKey,
      theme: 'light',
      size: 'flexible',
      language: 'zh-CN',
      // 与 NodeFlare 一致：默认显示并立即执行，通过后再收起。
      appearance: 'always',
      execution: 'render',
      // 校验通过后不再自动刷新过期令牌（登录是一次性动作）
      'refresh-expired': 'manual',

      callback: (token: string) => {
        this.token = token
        this.widgetSection.hidden = true
        this.syncSubmitState()
      },

      'expired-callback': () => {
        this.token = ''
        this.widgetSection.hidden = false
        this.syncSubmitState()
      },

      'error-callback': () => {
        this.token = ''
        this.widgetSection.hidden = false
        this.syncSubmitState()
        this.showError('人机校验出错，请重试')
      },

      'timeout-callback': () => {
        this.token = ''
        this.widgetSection.hidden = false
        this.syncSubmitState()
      },

      'unsupported-callback': () => {
        this.token = ''
        this.widgetSection.hidden = false
        this.showError('当前浏览器不支持人机校验组件，请更换浏览器后重试')
      },
    })
  }

  /** 重置小组件（token 一次性，失败后必须重置）。 */
  private resetWidget(): void {
    this.token = ''
    this.widgetSection.hidden = false
    if (this.widgetId !== null && window.turnstile) {
      window.turnstile.reset(this.widgetId)
    }
    this.syncSubmitState()
  }

  /**
   * 读取当前 token。
   *
   * `callback` 会带上 token；极少数情况下内部状态已就绪而本地变量还是空，
   * 此时用 `getResponse()` 兜底。
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
   * 不要求 token 非空：静默校验由 Cloudflare 异步完成，耗时不可预期，
   * 等待 token 会造成按钮长时间不可点。
   */
  private syncSubmitState(): void {
    const ready = !this.submitting && this.passwordInput.value.length > 0
    this.submitButton.disabled = !ready

    replaceChildren(
      this.submitButton,
      ...(this.submitting
        ? [iconSvg(icons.spinner, 18, 'spin'), el('span', { text: '验证中…' })]
        : [el('span', { text: '登录' })]),
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
    if (this.widgetId !== null && window.turnstile) {
      window.turnstile.remove(this.widgetId)
      this.widgetId = null
    }
  }
}
