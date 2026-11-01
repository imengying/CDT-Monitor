/**
 * Cron 表达式编辑器
 * ============================================================================
 * 进阶模式下配置五字段表达式（分 时 日 月 周）。提供「每天 / 每周 / 每月 /
 * 自定义」四种快捷方式，等价于上游的频率下拉；选完仍然落到表达式上，
 * 所以用户可以随时切到「自定义」手改。
 *
 * 预览按钮调用 `POST /api/v1/cron/preview`，由后端解析并返回未来几次触发，
 * 避免前端再实现一套 cron 解析（会和服务端算出不同结果）。
 */

import { api, formatTime } from '@/api/client'
import { el } from '@/lib/dom'

/** 频率预设。 */
type Frequency = 'off' | 'daily' | 'weekly' | 'monthly' | 'custom'

const FREQUENCY_LABELS: readonly (readonly [Frequency, string])[] = [
  ['off', '不启用'],
  ['daily', '每天'],
  ['weekly', '每周'],
  ['monthly', '每月'],
  ['custom', '自定义'],
]

const WEEKDAYS: readonly (readonly [string, string])[] = [
  ['1', '周一'],
  ['2', '周二'],
  ['3', '周三'],
  ['4', '周四'],
  ['5', '周五'],
  ['6', '周六'],
  ['0', '周日'],
]

/** 把表达式拆成编辑器需要的各部分。解析不出来时按「自定义」处理。 */
function parseExpression(value: string, fallback: { hour: number; minute: number }): {
  frequency: Frequency
  time: string
  dayOfMonth: string
  weekday: string
} {
  const parts = value.trim().split(/\s+/)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const fallbackTime = `${pad(fallback.hour)}:${pad(fallback.minute)}`

  if (parts.length !== 5) {
    return {
      frequency: value.trim() ? 'custom' : 'off',
      time: fallbackTime,
      dayOfMonth: '1',
      weekday: '1',
    }
  }

  const [minuteField, hourField, dom, , dow] = parts
  const numeric = /^\d+$/.test(minuteField) && /^\d+$/.test(hourField)
  if (!numeric) {
    return { frequency: 'custom', time: fallbackTime, dayOfMonth: '1', weekday: '1' }
  }
  const time = `${pad(Number(hourField))}:${pad(Number(minuteField))}`

  // 月 / 周字段决定频率
  if (dom === '*' && dow === '*') {
    return { frequency: 'daily', time, dayOfMonth: '1', weekday: '1' }
  }
  if (dom === '*' && /^\d$/.test(dow)) {
    return { frequency: 'weekly', time, dayOfMonth: '1', weekday: dow }
  }
  if (/^\d+$/.test(dom) && dow === '*') {
    return { frequency: 'monthly', time, dayOfMonth: dom, weekday: '1' }
  }
  return { frequency: 'custom', time, dayOfMonth: '1', weekday: '1' }
}

/** 由频率与时/日拼出表达式。 */
function buildExpression(frequency: Frequency, time: string, dom: string, dow: string): string {
  const [hour, minute] = time.split(':')
  const h = String(Number(hour))
  const m = String(Number(minute))
  switch (frequency) {
    case 'off':
      return ''
    case 'daily':
      return `${m} ${h} * * *`
    case 'weekly':
      return `${m} ${h} * * ${dow}`
    case 'monthly':
      return `${m} ${h} ${dom} * *`
    default:
      return ''
  }
}

export interface CronEditorOptions {
  /** 标题，例如「定时开机」。 */
  label: string
  /** 当前表达式，空串表示未启用。 */
  value: string
  /** 时区，用于预览换算。 */
  timezone: string
  /** 未启用时的默认时刻，让用户在切到「每天」时有合理起点。 */
  defaultTime: { hour: number; minute: number }
  onChange: (value: string) => void
}

/** Cron 编辑器。返回的节点内部自己管理状态。 */
export function cronEditor(options: CronEditorOptions): HTMLElement {
  let value = options.value
  let preview: number[] = []
  let previewError = ''
  let busy = false

  const root = el('div', { class: 'cron-field' })

  const paint = (): void => {
    const state = parseExpression(value, options.defaultTime)

    const frequencySelect = el('select', { class: 'native-select cron-field__freq' }) as HTMLSelectElement
    for (const [key, label] of FREQUENCY_LABELS) {
      frequencySelect.append(el('option', { value: key, text: label }))
    }
    frequencySelect.value = state.frequency
    frequencySelect.addEventListener('change', () => {
      const next = frequencySelect.value as Frequency
      if (next === 'custom') {
        // 切到自定义时，保留当前表达式让用户接着改
        value = value || buildExpression('daily', state.time, '1', '1')
      } else {
        value = buildExpression(next, state.time, state.dayOfMonth, state.weekday)
      }
      preview = []
      previewError = ''
      options.onChange(value)
      paint()
    })

    const timeInput = el('input', {
      class: 'cron-field__input',
      type: 'time',
      value: state.time,
      'aria-label': `${options.label}时间`,
    }) as HTMLInputElement
    timeInput.addEventListener('change', () => {
      if (!timeInput.value) return
      value = buildExpression(state.frequency, timeInput.value, state.dayOfMonth, state.weekday)
      preview = []
      previewError = ''
      options.onChange(value)
      paint()
    })

    const parts: HTMLElement[] = [frequencySelect]

    if (state.frequency === 'weekly') {
      const weekdaySelect = el('select', { class: 'native-select cron-field__unit' }) as HTMLSelectElement
      for (const [key, label] of WEEKDAYS) {
        weekdaySelect.append(el('option', { value: key, text: label }))
      }
      weekdaySelect.value = state.weekday
      weekdaySelect.addEventListener('change', () => {
        value = buildExpression('weekly', state.time, '1', weekdaySelect.value)
        preview = []
        previewError = ''
        options.onChange(value)
        paint()
      })
      parts.push(weekdaySelect)
    }

    if (state.frequency === 'monthly') {
      const domSelect = el('select', { class: 'native-select cron-field__unit' }) as HTMLSelectElement
      for (let i = 1; i <= 31; i++) domSelect.append(el('option', { value: String(i), text: `${i} 日` }))
      domSelect.value = state.dayOfMonth
      domSelect.addEventListener('change', () => {
        value = buildExpression('monthly', state.time, domSelect.value, '1')
        preview = []
        previewError = ''
        options.onChange(value)
        paint()
      })
      parts.push(domSelect)
    }

    if (state.frequency !== 'off' && state.frequency !== 'custom') {
      parts.push(timeInput)
    }

    if (state.frequency === 'custom') {
      const raw = el('input', {
        class: 'cron-field__input cron-field__input--raw',
        type: 'text',
        value,
        placeholder: '0 3 * * 1',
        spellcheck: false,
        'aria-label': `${options.label}表达式`,
      }) as HTMLInputElement
      raw.addEventListener('input', () => {
        value = raw.value
        preview = []
        previewError = ''
        options.onChange(value)
      })
      parts.push(raw)
    }

    const previewButton = el('button', {
      class: 'button button--secondary button--small cron-field__preview',
      type: 'button',
      text: busy ? '预览中…' : '预览',
      ...(busy || !value ? { disabled: 'disabled' } : {}),
      on: {
        click: () => {
          void runPreview()
        },
      },
    })
    parts.push(previewButton)

    const children: HTMLElement[] = [
      el('div', { class: 'cron-field__row' }, ...parts),
    ]

    if (state.frequency === 'off') {
      children.push(el('p', { class: 'field-hint', text: '未启用' }))
    } else {
      children.push(el('code', { class: 'cron-field__expr', text: value }))
    }

    if (previewError) {
      children.push(el('p', { class: 'cron-field__error', text: previewError }))
    } else if (preview.length > 0) {
      children.push(
        el(
          'div',
          { class: 'cron-field__preview-list' },
          el('span', { text: `未来 ${preview.length} 次 · ${options.timezone}` }),
          ...preview.map((ms) => el('time', { text: formatTime(ms) })),
        ),
      )
    }

    root.replaceChildren(...children)
  }

  const runPreview = async (): Promise<void> => {
    if (!value.trim()) return
    busy = true
    previewError = ''
    paint()
    try {
      const result = await api.previewCron(value, options.timezone, 5)
      preview = result.occurrences ?? []
    } catch (error) {
      preview = []
      previewError = error instanceof Error ? error.message : '表达式无法预览'
    } finally {
      busy = false
      paint()
    }
  }

  paint()
  return root
}
