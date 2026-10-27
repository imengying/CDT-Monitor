/**
 * 提示条容器
 * ============================================================================
 * 照搬上游 `toast-stack`：右下角堆叠、白色浮层、彩色图标区分色调、
 * 自动消失（超时由 store 控制）。
 */

import { el, iconSvg, replaceChildren } from '@/lib/dom'
import { icons } from '@/lib/icons'
import { dismissToast, type Toast } from '@/lib/store'

/** Toast 根节点（惰性创建）。 */
let root: HTMLDivElement | null = null

function ensureRoot(): HTMLDivElement {
  if (root) return root
  root = el('div', { class: 'toast-stack', 'aria-live': 'polite', role: 'status' })
  document.body.append(root)
  return root
}

/** 色调 → 类名与图标。 */
function toneOf(tone: Toast['tone']): { className: string; icon: typeof icons.check } {
  if (tone === 'danger') return { className: 'toast--error', icon: icons.alert }
  if (tone === 'warn') return { className: 'toast--error', icon: icons.alert }
  return { className: 'toast--success', icon: icons.check }
}

/** 渲染 toast 列表。 */
export function renderToasts(toasts: Toast[]): void {
  const container = ensureRoot()

  replaceChildren(
    container,
    ...toasts.map((item) => {
      const tone = toneOf(item.tone)

      return el(
        'div',
        { class: `toast ${tone.className}`, 'data-tone': item.tone },
        iconSvg(tone.icon, 18),
        el('span', { text: item.text }),
        el(
          'button',
          {
            class: 'toast-close',
            type: 'button',
            'aria-label': '关闭提示',
            on: { click: () => dismissToast(item.id) },
          },
          iconSvg(icons.close, 13),
        ),
      )
    }),
  )
}
