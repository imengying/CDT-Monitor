/**
 * 操作日志的共用展示逻辑
 * ============================================================================
 * 设置页的「日志」页签与独立抽屉共用同一套标签、圆点色调与行渲染，
 * 避免两处各写一份、以后改了忘同步。
 */

import { formatTime, type ActionLog } from '@/api/client'
import { el } from '@/lib/dom'

/** 动作类型 → 中文名。 */
export const ACTION_LABELS: Record<string, string> = {
  threshold_triggered: '流量熔断',
  threshold_stop: '熔断停机',
  threshold_stop_failed: '熔断停机失败',
  schedule_start: '定时开机',
  schedule_start_failed: '定时开机失败',
  schedule_start_blocked: '定时开机被拦',
  schedule_stop: '定时关机',
  schedule_stop_failed: '定时关机失败',
  spot_keep_alive: '抢占式保活',
  spot_keep_alive_failed: '抢占式保活失败',
  keep_alive_enabled: '开启保活',
  keep_alive_disabled: '关闭保活',
  manual_start: '手动开机',
  manual_start_failed: '手动开机失败',
  manual_stop: '手动关机',
  manual_stop_failed: '手动关机失败',
  refresh_warning: '采集告警',
  refresh_failed: '采集失败',
  account_created: '新增账号',
  account_updated: '更新账号',
  account_deleted: '删除账号',
  login_success: '登录成功',
  login_failed: '登录失败',
  login_turnstile_failed: '人机校验失败',
  notify_failed: '通知失败',
  notify_test_all: '测试通知',
  notify_test_telegram: '测试 Telegram',
  notify_test_bark: '测试 Bark',
  daily_report: '日报推送',
  daily_report_manual: '手动日报',
  settings_telegram: 'Telegram 设置',
  settings_bark: 'Bark 设置',
}

/** 日志筛选维度。 */
export const LOG_FILTERS = [
  ['', '全部'],
  ['login', '登录'],
  ['threshold', '熔断'],
  ['schedule', '定时'],
  ['spot', '保活'],
  ['manual', '手动'],
  ['notify', '通知'],
] as const

export type LogFilterKey = (typeof LOG_FILTERS)[number][0]

/** 日志圆点色调。 */
function dotClass(actionType: string): string {
  if (
    actionType.includes('failed') ||
    actionType.includes('threshold') ||
    actionType.includes('blocked')
  ) {
    return 'log-dot--error'
  }
  if (actionType.startsWith('notify') || actionType.includes('report')) {
    return 'log-dot--info'
  }
  return ''
}

/**
 * 实例 ID 掩码。
 *
 * 只留前 4 位与后 4 位，中间用 `…`：例如 `i-bp1****xyz9`。
 * 短于 10 位时整体打码，避免露出太多。
 */
export function maskInstanceId(id: string | null | undefined): string {
  const value = (id ?? '').trim()
  if (!value) return ''
  if (value.length <= 10) return '****'
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}

/** 单条日志行。 */
export function logRow(log: ActionLog): HTMLElement {
  return el(
    'div',
    { class: 'log-row' },
    el('i', { class: `log-dot ${dotClass(log.action_type)}` }),
    el(
      'div',
      {},
      el('p', { text: log.detail }),
      el('span', {
        text: [
          ACTION_LABELS[log.action_type] ?? log.action_type,
          log.account_name,
          maskInstanceId(log.instance_id),
          formatTime(log.created_at),
        ]
          .filter(Boolean)
          .join(' · '),
      }),
    ),
  )
}
