import { App } from '@/App'
import { mustGetById } from '@/lib/dom'
import { initTheme } from '@/lib/theme'
import './style.css'

/**
 * 应用入口。
 *
 * 1. 接管主题：首屏颜色已由 `theme-init.js` 落地，这里只装运行时同步
 *    （跟随系统、跨标签页）；
 * 2. 注册 401 广播（任意接口返回 401 时立刻切回登录页）；
 * 3. 拿到挂载点并启动外壳。
 */
initTheme()

const root = mustGetById('app')
const app = new App(root)
app.start()
