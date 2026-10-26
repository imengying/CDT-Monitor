/**
 * 登录卡片
 * ============================================================================
 * 居中登录卡片 + Cloudflare Turnstile。
 *
 * Turnstile 使用 `appearance: 'interaction-only'`：静默验证通过时卡片上
 * 不出现任何人机校验痕迹，仅在 Cloudflare 判定可疑时原地展开复选框。
 * 容器的可见性完全交由 Cloudflare 控制，不手动设置 `display`。
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
import { el, iconSvg, replaceChildren } from '@/lib/dom'
import { icons } from '@/lib/icons'
import { afterLogin } from '@/lib/actions'
import { store } from '@/lib/store'

const TURNSTILE_SCRIPT_TIMEOUT_MS = 10_000

/** 登录卡片组件。 */
export class LoginModal {
  readonly element: HTMLDivElement

  private readonly card: HTMLFormElement
  private readonly usernameInput: HTMLInputElement
  private readonly passwordInput: HTMLInputElement
  private readonly submitButton: HTMLButtonElement
  private readonly widgetHost: HTMLDivElement
  private readonly errorBox: HTMLDivElement
  private readonly statusHint: HTMLParagraphElement

  private widgetId: string | null = null
  private token = ''
  private submitting = false
  private disposed = false
  private pollTimer: number | null = null

  constructor(private readonly siteKey: string) {
    this.usernameInput = el('input', {
      class: 'input',
      id: 'admin-username',
      type: 'text',
      autocomplete: 'username',
      autocapitalize: 'off',
      spellcheck: 'false',
      placeholder: '管理员用户名',
    })

    this.passwordInput = el('input', {
      class: 'input',
      id: 'admin-password',
      type: 'password',
      autocomplete: 'current-password',
      placeholder: '请输入管理员密码',
    })

    this.submitButton = el(
      'button',
      { class: 'btn btn-primary w-full', type: 'submit' },
      '登录',
    ) as HTMLButtonElement

    this.widgetHost = el('div', { class: 'cf-turnstile' })

    this.errorBox = el('div', {
      class: 'mb-4 hidden items-start gap-2 rounded-lg px-3 py-2 text-xs',
      role: 'alert',
      style: {
        backgroundColor: 'var(--color-danger-soft)',
        color: 'var(--color-danger)',
      },
    })

    this.statusHint = el('p', {
      class: 'mt-2 hidden items-center gap-1.5 text-xs',
      style: { color: 'var(--color-ink-subtle)' },
    })

    this.card = el(
      'form',
      {
        class: 'card p-6',
        on: {
          submit: (event) => {
            event.preventDefault()
            void this.submit()
          },
        },
      },
      el(
        'div',
        { class: 'mb-3' },
        el(
          'label',
          { class: 'label', for: 'admin-username' },
          el(
            'span',
            { class: 'inline-flex items-center gap-1.5' },
            iconSvg(icons.cloud, 13),
            '用户名',
          ),
        ),
        this.usernameInput,
      ),
      el(
        'div',
        { class: 'mb-5' },
        el(
          'label',
          { class: 'label', for: 'admin-password' },
          el('span', { class: 'inline-flex items-center gap-1.5' }, iconSvg(icons.key, 13), '密码'),
        ),
        this.passwordInput,
      ),
      this.buildTurnstileSection(),
      this.errorBox,
      this.submitButton,
      el('p', {
        class: 'mt-4 text-center text-[11px] leading-relaxed',
        style: { color: 'var(--color-ink-subtle)' },
        text: '受 Cloudflare Turnstile 保护，会话 Cookie 为 HttpOnly + SameSite=Strict',
      }),
    )

    this.element = el(
      'div',
      { class: 'flex min-h-full items-center justify-center px-4 py-10' },
      el(
        'div',
        { class: 'w-full max-w-sm' },
        this.buildBrand(),
        this.card,
      ),
    )

    this.usernameInput.addEventListener('input', () => this.syncSubmitState())
    this.passwordInput.addEventListener('input', () => this.syncSubmitState())

    if (this.siteKey.trim()) {
      void this.renderWidget()
    }
  }

  /** 品牌区。 */
  private buildBrand(): HTMLDivElement {
    return el(
      'div',
      { class: 'mb-6 flex flex-col items-center gap-3 text-center' },
      el(
        'div',
        {
          class: 'flex h-12 w-12 items-center justify-center rounded-2xl text-white shadow-lg',
          style: { background: 'linear-gradient(135deg, #2563eb, #0ea5e9)' },
        },
        iconSvg(icons.shield, 24),
      ),
      el(
        'div',
        {},
        el('h1', { class: 'text-lg font-semibold tracking-tight', text: 'CDT Monitor' }),
        el('p', {
          class: 'mt-0.5 text-xs',
          style: { color: 'var(--color-ink-muted)' },
          text: '阿里云流量监控与实例自动化控制',
        }),
      ),
    )
  }

  /**
   * Turnstile 区域。
   *
   * 容器始终留在 DOM 中且不手动设置 `display`：`appearance: 'interaction-only'`
   * 已保证无交互需求时不渲染可见内容。被 `display: none` 隐藏的容器内
   * Turnstile 不会执行校验，token 无法获取。
   */
  private buildTurnstileSection(): HTMLDivElement {
    const available = this.siteKey.trim().length > 0

    if (!available) {
      // 后台没启用 Turnstile（默认状态）：什么都不渲染，卡片保持干净。
      // 不显示"未配置"告警 —— 这是正常配置，不是故障。
      return el('div', { class: 'hidden', dataset: { role: 'turnstile-off' } })
    }

    // 不给容器加固定高度：静默通过时它自然塌陷为 0，不影响卡片布局。
    return el(
      'div',
      { class: 'mb-5', dataset: { role: 'turnstile-section' } },
      this.widgetHost,
      this.statusHint,
    )
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
    this.showStatus('正在加载人机校验…', true)

    const ready = await this.waitForTurnstile()
    if (this.disposed) return

    if (!ready || !window.turnstile) {
      this.showStatus('人机校验组件加载失败，请检查网络后刷新页面', false)
      this.showError('人机校验组件加载失败，请刷新页面重试')
      return
    }

    this.showStatus('', false)

    if (this.widgetId !== null) return

    this.widgetId = window.turnstile.render(this.widgetHost, {
      sitekey: this.siteKey,
      theme: 'auto',
      size: 'flexible',
      language: 'zh-CN',
      // 关键：默认不显示，仅在需要人工交互时才展开复选框
      appearance: 'interaction-only',
      // 校验通过后不再自动刷新过期令牌（登录是一次性动作）
      'refresh-expired': 'manual',

      callback: (token: string) => {
        this.token = token
        this.hideError()
        this.showStatus('', false)
        this.syncSubmitState()
      },

      // 只有被判定需要人工确认时，Turnstile 自己会把复选框画出来，
      // 我们只需在下方补一句说明。
      'before-interactive-callback': () => {
        this.showStatus('请完成下方的人机校验', true)
      },

      'after-interactive-callback': () => {
        this.showStatus('', false)
      },

      'expired-callback': () => {
        this.token = ''
        this.syncSubmitState()
      },

      'error-callback': () => {
        this.token = ''
        this.showStatus('', false)
        this.syncSubmitState()
        this.showError('人机校验出错，请重试')
      },

      'timeout-callback': () => {
        this.token = ''
        this.showStatus('', false)
        this.syncSubmitState()
      },

      'unsupported-callback': () => {
        // 浏览器不支持 / 站点配置异常：明确提示，别留下静默失败的卡片
        this.showStatus('', false)
        this.showError('当前浏览器不支持人机校验组件，请更换浏览器后重试')
      },
    })
  }

  /** 重置小组件（token 一次性，失败后必须重置）。 */
  private resetWidget(): void {
    this.token = ''
    this.showStatus('', false)
    if (this.widgetId !== null && window.turnstile) {
      window.turnstile.reset(this.widgetId)
    }
    this.syncSubmitState()
  }

  /**
   * 读取当前 token。
   *
   * `interaction-only` 下静默校验通过时，`callback` 会带上 token；
   * 但极少数情况下（例如回调时序）内部状态已就绪而本地变量还是空，
   * 此时用 `getResponse()` 兜底，避免误判为「未通过校验」。
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
   * 条件为「已填密码且未在提交中」，token 于提交瞬间读取，
   * 未就绪时给出提示（见 `submit()`）。
   */
  private syncSubmitState(): void {
    const ready = !this.submitting && this.passwordInput.value.length > 0

    this.submitButton.disabled = !ready
    replaceChildren(
      this.submitButton,
      ...(this.submitting
        ? [iconSvg(icons.spinner, 15, 'animate-spin'), el('span', { text: '验证中…' })]
        : [el('span', { text: '登录' })]),
    )
  }

  private showStatus(text: string, visible: boolean): void {
    if (!visible || !text) {
      this.statusHint.classList.add('hidden')
      this.statusHint.classList.remove('flex')
      this.statusHint.replaceChildren()
      return
    }
    this.statusHint.classList.remove('hidden')
    this.statusHint.classList.add('flex')
    replaceChildren(this.statusHint, iconSvg(icons.spinner, 12, 'animate-spin'), el('span', { text }))
  }

  private showError(message: string): void {
    this.errorBox.classList.remove('hidden')
    this.errorBox.classList.add('flex')
    replaceChildren(
      this.errorBox,
      iconSvg(icons.alert, 14),
      el('span', { class: 'leading-relaxed', text: message }),
    )
  }

  private hideError(): void {
    this.errorBox.classList.add('hidden')
    this.errorBox.classList.remove('flex')
    this.errorBox.replaceChildren()
  }

  /** 提交登录。 */
  private async submit(): Promise<void> {
    if (this.submitting) return
    if (!this.passwordInput.value) return

    const token = this.currentToken()
    if (this.siteKey.trim() && !token) {
      // 静默校验尚未完成：提示用户稍候，而不是静默失败
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
