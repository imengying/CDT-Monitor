/**
 * 提示条容器（原版无独立组件，此处单独抽出）
 * ============================================================================
 * 固定在底部居中，3 种色调与卡片风格一致，点击 × 或超时自动消失。
 */

import { el, iconSvg, replaceChildren } from '@/lib/dom'
import { icons } from '@/lib/icons'
import { dismissToast, type Toast } from '@/lib/store'

/** Toast 根节点（惰性创建）。 */
let root: HTMLDivElement | null = null

function ensureRoot(): HTMLDivElement {
  if (root) return root
  root = el('div', {
    class:
      'pointer-events-none fixed bottom-4 left-1/2 z-[60] flex w-full max-w-md -translate-x-1/2 flex-col gap-2 px-4',
    role: 'status',
    'aria-live': 'polite',
  })
  document.body.append(root)
  return root
}

/** 单条 toast 的配色。 */
function toneStyle(tone: Toast['tone']): { border: string; background: string; color: string } {
  if (tone === 'danger') {
    return {
      border: 'color-mix(in oklab, var(--color-danger) 35%, transparent)',
      background: 'var(--color-danger-soft)',
      color: 'var(--color-danger)',
    }
  }
  if (tone === 'warn') {
    return {
      border: 'color-mix(in oklab, var(--color-warn) 35%, transparent)',
      background: 'var(--color-warn-soft)',
      color: 'var(--color-warn)',
    }
  }
  return {
    border: 'color-mix(in oklab, var(--color-ok) 35%, transparent)',
    background: 'var(--color-ok-soft)',
    color: 'var(--color-ok)',
  }
}

/** 渲染 toast 列表。 */
export function renderToasts(toasts: Toast[]): void {
  const container = ensureRoot()
  replaceChildren(
    container,
    ...toasts.map((item) => {
      const palette = toneStyle(item.tone)
      const closeButton = el(
        'button',
        {
          class: 'shrink-0 opacity-60 transition-opacity hover:opacity-100',
          type: 'button',
          'aria-label': '关闭提示',
          on: { click: () => dismissToast(item.id) },
        },
        iconSvg(icons.close, 12),
      )

      return el(
        'div',
        {
          class: 'pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 text-xs shadow-lg',
          data: { tone: item.tone },
          style: {
            borderColor: palette.border,
            backgroundColor: palette.background,
            color: palette.color,
          },
        },
        el(
          'span',
          { class: 'mt-0.5' },
          iconSvg(item.tone === 'ok' ? icons.check : icons.alert, 14),
        ),
        el('span', {
          class: 'flex-1 leading-relaxed break-words',
          text: item.text,
        }),
        closeButton,
      )
    }),
  )
}
