import { api, ApiError, formatTime, relativeTime, type SessionDevice, type SessionsResponse } from '@/api/client'
import { reportError } from '@/lib/actions'
import { el, subtleEmpty } from '@/lib/dom'
import { icons } from '@/lib/icons'
import { toast } from '@/lib/store'

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

export class SessionDevices {
  private sessions: SessionDevice[] | null = null
  private pending: string | null = null

  private readonly list = el('div', { class: 'device-list' })
  private readonly error = el('div', { class: 'inline-error', role: 'alert', hidden: true })
  private readonly refreshButton = el('button', {
    class: 'button button--secondary button--small',
    type: 'button',
    text: '刷新',
    on: { click: () => this.refresh(true) },
  })
  private readonly revokeButton = el('button', {
    class: 'button button--secondary button--small',
    type: 'button',
    text: '退出其它设备',
    on: { click: () => void this.request('others', () => api.revokeOtherSessions(), '其它设备已全部下线') },
  })
  readonly element = el(
    'div',
    { class: 'settings-section' },
    el('div', { class: 'device-actions' }, this.revokeButton, this.refreshButton),
    this.error,
    this.list,
  )

  refresh(notify = false): void {
    void this.request('refresh', () => api.sessions(), notify ? '设备列表已刷新' : '')
  }

  private async request(action: string, send: () => Promise<SessionsResponse>, message: string): Promise<void> {
    if (this.pending !== null) return
    this.pending = action
    this.error.hidden = true
    this.paint()
    try {
      this.sessions = (await send()).sessions
      if (message && this.element.isConnected && !this.element.closest('[hidden]')) toast(message, 'ok')
    } catch (error) {
      if (error instanceof ApiError && error.isUnauthorized) {
        if (this.element.isConnected) reportError(error, '会话已失效')
      } else {
        const fallback = action === 'refresh' ? '读取登录设备失败，请重试' : '退出设备失败，请重试'
        this.error.textContent = error instanceof ApiError ? error.message : fallback
        this.error.hidden = false
      }
    } finally {
      this.pending = null
      this.paint()
    }
  }

  private paint(): void {
    const busy = this.pending !== null
    this.refreshButton.disabled = busy
    this.revokeButton.disabled = busy || !this.sessions?.some(device => !device.current)
    this.refreshButton.textContent = this.pending === 'refresh' ? '刷新中…' : '刷新'
    this.revokeButton.textContent = this.pending === 'others' ? '处理中…' : '退出其它设备'
    this.list.setAttribute('aria-busy', String(busy))
    if (this.sessions === null) {
      this.list.replaceChildren()
      if (busy) this.list.append(subtleEmpty('正在加载…', icons.spinner))
    } else if (this.sessions.length === 0) {
      this.list.replaceChildren(subtleEmpty('暂无登录设备', icons.devices))
    } else {
      this.list.replaceChildren(...this.sessions.map(device => this.deviceRow(device)))
    }
  }

  private deviceRow(device: SessionDevice): HTMLElement {
    return el(
      'div',
      { class: 'device-row' },
      el('div', { class: 'device-row__title' },
        el('b', { text: deviceName(device.ua) }),
        device.current ? el('span', { class: 'badge badge-ok', text: '本机' }) : null,
      ),
      el('span', {
        text: `${device.ip || '未知来源'} · 登录于 ${formatTime(device.created_at)} · 最近活跃 ${relativeTime(device.last_seen_at)}`,
      }),
      device.current ? null : el('button', {
        class: 'button button--secondary button--small',
        type: 'button',
        disabled: this.pending !== null,
        text: this.pending === device.sid ? '处理中…' : '下线',
        on: { click: () => void this.request(device.sid, () => api.revokeSession(device.sid), '该设备已下线') },
      }),
    )
  }
}
