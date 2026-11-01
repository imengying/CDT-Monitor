/**
 * Cron 表达式输入
 * ============================================================================
 * 五字段（分 时 日 月 周）。直接输入表达式，右侧按钮校验并预览未来几次触发，
 * 结果由后端解析（前端不再实现一套 cron 解析，避免两边算出不同结果）。
 *
 * 常见写法：
 *   `0 8 * * *`     每天 08:00
 *   `0 3 * * 1`     每周一 03:00
 *   `0 4 1 * *`     每月 1 号 04:00
 */

import { api } from '@/api/client'
import { el } from '@/lib/dom'

export interface CronInputOptions {
  /** 标题，例如「定时开机」。 */
  label: string
  /** 当前表达式，空串表示未启用。 */
  value: string
  /** 时区，用于预览换算。 */
  timezone: string
  /** 输入框占位符。 */
  placeholder?: string
  onChange: (value: string) => void
}

/** Cron 表达式输入框 + 预览。 */
export function cronInput(options: CronInputOptions): HTMLElement {
  let preview: string[] = []
  let error = ''
  let busy = false

  const root = el('div', { class: 'cron-field' })
  const hint = el('div', { class: 'cron-field__hint' })

  const input = el('input', {
    class: 'cron-field__input cron-field__input--raw',
    type: 'text',
    value: options.value,
    placeholder: options.placeholder ?? '0 8 * * *',
    spellcheck: false,
    autocomplete: 'off',
    autocapitalize: 'off',
    'aria-label': `${options.label}表达式`,
  }) as HTMLInputElement

  const replaceHint = (node: HTMLElement, reserve: boolean): void => {
    root.querySelector('.cron-field__hint')?.replaceChildren(node)
    // 占位行与提示行共存时不让布局跳动
    hint.hidden = !reserve && !node.textContent
  }

  const paintHint = (): void => {
    if (error) {
      replaceHint(el('p', { class: 'cron-field__error', text: error }), false)
      return
    }
    if (preview.length > 0) {
      replaceHint(
        el(
          'div',
          { class: 'cron-field__preview-list' },
          el('span', { text: `未来 ${preview.length} 次 · ${options.timezone}` }),
          ...preview.map((text) => el('time', { text })),
        ),
        true,
      )
      return
    }
    // 没有预览也没有错误：空值给格式提示，有值提示点「预览」
    replaceHint(
      el('p', {
        class: 'field-hint',
        text: options.value.trim()
          ? '五字段：分 时 日 月 周'
          : '留空表示不启用',
      }),
      true,
    )
  }

  const runPreview = async (): Promise<void> => {
    const expression = input.value.trim()
    if (!expression) {
      preview = []
      error = ''
      paintHint()
      return
    }
    busy = true
    error = ''
    previewButton.disabled = true
    previewButton.textContent = '预览中…'
    try {
      const result = await api.previewCron(expression, options.timezone, 5)
      preview = result.occurrences.map((ms) => formatLocal(ms, options.timezone))
      error = ''
    } catch (err) {
      preview = []
      error = err instanceof Error ? err.message : '表达式无法预览'
    } finally {
      busy = false
      previewButton.disabled = false
      previewButton.textContent = '预览'
      paintHint()
    }
  }

  const previewButton = el('button', {
    class: 'button button--secondary button--small cron-field__preview',
    type: 'button',
    text: '预览',
    on: {
      click: () => {
        void runPreview()
      },
    },
  }) as HTMLButtonElement

  input.addEventListener('input', () => {
    // 改动后旧预览就不再对应当前表达式，先清掉
    preview = []
    error = ''
    options.onChange(input.value)
    paintHint()
  })
  input.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter') {
      event.preventDefault()
      void runPreview()
    }
  })

  root.append(
    el('div', { class: 'cron-field__row' }, input, previewButton),
    hint,
  )
  paintHint()
  void busy
  return root
}

/** 把毫秒时间戳格式化成 `YYYY-MM-DD HH:MM`（按给定时区偏移）。 */
function formatLocal(ms: number, timezone: string): string {
  const offsetMinutes = parseOffset(timezone)
  const date = new Date(ms + offsetMinutes * 60_000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
}

/** 解析 `UTC+8` / `GMT+08:00` / `+9` 形式的偏移（分钟）。 */
function parseOffset(timezone: string): number {
  const upper = timezone.trim().toUpperCase()
  const body = upper.replace(/^(UTC|GMT)/, '').trim()
  if (!body) return 0
  const match = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(body)
  if (!match) return 0
  const sign = match[1] === '-' ? -1 : 1
  const hours = Number(match[2])
  const minutes = Number(match[3] ?? 0)
  return sign * (hours * 60 + minutes)
}
