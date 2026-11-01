/**
 * 外观主题
 * ============================================================================
 * 三档：浅色 / 深色 / 跟随系统。只切换 `<html data-theme>`，配色全在 CSS 变量里，
 * 不涉及任何布局或动效改动。
 *
 * 首屏不闪烁靠 `theme-init.js`：它在 `<head>` 里、样式表之前同步执行，
 * 先把 `data-theme` 落到 `<html>` 上，等 CSS 加载时颜色已经正确。
 * 这里只负责运行期的切换、持久化与跨标签页同步。
 */

export type ThemeMode = 'light' | 'dark' | 'system'
export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'cdt-monitor.appearance.v1'
const MEDIA = '(prefers-color-scheme: dark)'

/** 主题切换时派发的事件名，供 UI 刷新选中态。 */
export const THEME_EVENT = 'cdt-theme-change'

export interface ThemePreferences {
  mode: ThemeMode
}

function normalize(value: unknown): ThemePreferences {
  const input = (value && typeof value === 'object' ? value : {}) as Partial<ThemePreferences>
  const mode = input.mode
  // 旧版本可能存过别的值，一律回落到 system
  return { mode: mode === 'light' || mode === 'dark' ? mode : 'system' }
}

/** 读取已保存的偏好。localStorage 不可用时退回默认值。 */
export function readPreferences(): ThemePreferences {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return normalize(raw ? JSON.parse(raw) : null)
  } catch {
    return { mode: 'system' }
  }
}

/** 解析出实际生效的主题。 */
export function resolveTheme(preferences: ThemePreferences, systemDark = systemPrefersDark()): Theme {
  if (preferences.mode === 'light' || preferences.mode === 'dark') return preferences.mode
  return systemDark ? 'dark' : 'light'
}

function systemPrefersDark(): boolean {
  return window.matchMedia(MEDIA).matches
}

/** 把主题写到 `<html>` 上，并同步浏览器 UI 配色。 */
function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#14171b' : '#f1f3f5')
}

/** 当前生效的主题。 */
export function currentTheme(): Theme {
  return resolveTheme(readPreferences())
}

/** 当前保存的外观模式（`light` / `dark` / `system`）。 */
export function currentMode(): ThemeMode {
  return readPreferences().mode
}

/**
 * 切换外观模式并立即生效。
 *
 * 写入失败（隐私模式、配额满）时仍然应用，只是下次打开会回到默认值，
 * 这种情况不打断用户操作。
 */
export function setThemeMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode }))
  } catch {
    /* 存不下就算了，本次会话仍然生效 */
  }
  const theme = resolveTheme({ mode })
  applyTheme(theme)
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { mode, theme } }))
}

/** 启动时调用：应用已保存的主题，并跟随系统与其它标签页的变化。 */
export function initTheme(): void {
  applyTheme(currentTheme())

  const media = window.matchMedia(MEDIA)
  const sync = (): void => {
    // 只有「跟随系统」模式才需要响应系统切换
    if (readPreferences().mode !== 'system') return
    applyTheme(currentTheme())
    window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { mode: 'system', theme: currentTheme() } }))
  }

  media.addEventListener('change', sync)
  // 其它标签页改了偏好，这里同步过来
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return
    const mode = readPreferences().mode
    applyTheme(resolveTheme({ mode }))
    window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { mode, theme: currentTheme() } }))
  })
}


/**
 * 在「浅色 / 深色」之间快速切换。
 *
 * 只在这两者之间来回，不经过「跟随系统」——跟随系统需要显式选择，
 * 放在设置页里。当前若是跟随系统，则切到与当前生效主题相反的那个。
 */
export function toggleTheme(): Theme {
  const current = currentTheme()
  const next: Theme = current === 'dark' ? 'light' : 'dark'
  setThemeMode(next)
  return next
}
