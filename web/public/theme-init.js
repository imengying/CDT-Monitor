/**
 * 首屏主题落地
 * ============================================================================
 * 在样式表之前同步执行，避免深色用户看到一帧白底。
 *
 * 为什么放在外部文件而不是内联脚本：
 * 保持与项目其余脚本一致的可缓存静态资源，也避免将来收紧 CSP
 * （`script-src 'self'`）时被内联策略拦截。
 */
;(function () {
  var STORAGE_KEY = 'cdt-monitor.appearance.v1'

  var mode = 'system'
  try {
    var raw = window.localStorage.getItem(STORAGE_KEY)
    var saved = raw ? JSON.parse(raw) : null
    var value = saved && typeof saved === 'object' ? saved.mode : ''
    if (value === 'light' || value === 'dark') mode = value
  } catch (_) {
    /* 读不到就用跟随系统 */
  }

  var theme =
    mode === 'light' || mode === 'dark'
      ? mode
      : window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'

  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
})()
