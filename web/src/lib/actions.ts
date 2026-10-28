/**
 * 数据操作层
 * ============================================================================
 * 所有「调用 API + 写入 store + 错误处理」的逻辑集中在这里，
 * 组件只负责渲染与转发用户事件。
 *
 * 统一约定：
 * * 任何 401 都会调用 `handleUnauthorized()`，把界面切回登录页；
 * * 所有失败都以 toast 形式反馈，不抛给调用方（除了需要就地展示的）；
 * * 写操作完成后自动刷新受影响的数据（概览 / 图表 / 设置）。
 */

import { ApiError, api, type NotifyChannel } from '@/api/client'
import { store, toast } from '@/lib/store'

/** 会话失效：清空数据并回到登录页。 */
function handleUnauthorized(notifyUser = true): void {
  store.patch({
    phase: 'unauthenticated',
    overview: null,
    settings: null,
    overviewError: '',
  })
  if (notifyUser) {
    toast('会话已失效，请重新登录', 'warn')
  }
}

/** 统一错误处理；返回是否已处理（会话失效）。 */
export function reportError(error: unknown, fallback: string): boolean {
  if (error instanceof ApiError) {
    if (error.isUnauthorized) {
      handleUnauthorized()
      return true
    }
    toast(error.message, 'danger')
    return false
  }
  toast(fallback, 'danger')
  return false
}

// ---------------------------------------------------------------------------
// 启动与会话
// ---------------------------------------------------------------------------

/** 首次加载：探测会话，已登录则拉取数据。 */
export async function bootstrap(): Promise<void> {
  try {
    const session = await api.session()
    store.patch({ session })

    if (!session.authenticated) {
      store.patch({ phase: 'unauthenticated' })
      return
    }
    store.patch({ phase: 'ready' })
    await Promise.all([loadOverview(), loadSettings()])
  } catch {
    // 会话接口本身失败（如 MASTER_KEY 未配置）也要落到登录页，避免空白屏
    store.patch({ phase: 'unauthenticated' })
  }
}

/** 登录成功后的初始化。 */
export async function afterLogin(): Promise<void> {
  store.patch({ phase: 'ready' })
  await Promise.all([loadOverview(), loadSettings()])
}

/** 退出登录。 */
export async function logout(): Promise<void> {
  try {
    await api.logout()
  } catch {
    // 退出接口失败也要清本地状态
  }
  handleUnauthorized(false)
  toast('已退出登录', 'ok')
}

// ---------------------------------------------------------------------------
// 概览
// ---------------------------------------------------------------------------

export async function loadOverview(refreshTransitional = false): Promise<void> {
  // 静默轮询不显示加载态，只有显式调用（登录后、动作后）才置 loading
  if (!refreshTransitional) {
    store.patch({ overviewLoading: true, overviewError: '' })
  }
  try {
    const overview = await api.overview(refreshTransitional)
    store.patch({ overview, overviewLoading: false })
  } catch (error) {
    store.patch({ overviewLoading: false })
    if (error instanceof ApiError && error.isUnauthorized) {
      handleUnauthorized()
      return
    }
    store.patch({
      overviewError: error instanceof ApiError ? error.message : '加载概览失败',
    })
  }
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

async function loadSettings(): Promise<void> {
  try {
    const settings = await api.settings()
    store.patch({ settings })
  } catch (error) {
    if (error instanceof ApiError && error.isUnauthorized) {
      handleUnauthorized()
      return
    }
    toast(error instanceof ApiError ? error.message : '加载设置失败', 'danger')
  }
}

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

/** 全局刷新（异步 Job）。 */
export async function refreshAll(): Promise<void> {
  if (store.get().refreshingAll) return
  store.patch({ refreshingAll: true })
  try {
    // 后端在部分失败时返回 success + 说明文案，全部失败时才 failed。
    // 两种情况都刷新界面：失败也需要看到最新的 warning 日志。
    await api.refreshAll()
    toast('账号已刷新', 'ok')
  } catch (error) {
    reportError(error, '刷新失败')
  } finally {
    store.patch({ refreshingAll: false })
    await loadOverview()
  }
}

/** 设置保存后的统一刷新。 */
export async function afterSettingsChanged(): Promise<void> {
  await Promise.all([loadSettings(), loadOverview()])
}

/** 单账号动作后的刷新。 */
export async function afterAccountChanged(): Promise<void> {
  await loadOverview()
}

/** 测试通知渠道。 */
export async function testNotification(channel: NotifyChannel): Promise<void> {
  try {
    await api.testNotify(channel)
    toast(`测试通知已发送（${channel}）`, 'ok')
  } catch (error) {
    reportError(error, '测试通知失败')
  }
}

/** 立即推送日报。 */
export async function pushDailyReport(): Promise<void> {
  try {
    await api.pushDailyReport()
    toast('日报已推送', 'ok')
  } catch (error) {
    reportError(error, '推送日报失败')
  }
}
