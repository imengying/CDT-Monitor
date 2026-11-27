import { App } from '@/App'
import { mustGetById } from '@/lib/dom'
import { initTheme } from '@/lib/theme'
import { preloadTurnstileScript } from '@/components/LoginModal'
import { store } from '@/lib/store'
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
// 与首屏会话探测并行建立 Cloudflare 连接、下载脚本。
void preloadTurnstileScript().catch(() => {
  // 登录组件复用此 Promise 并显示具体错误，这里避免未处理 rejection。
})

const root = mustGetById('app')
const app = new App(root)
app.start()
// 首屏立即画登录表单；会话有效时 bootstrap 会直接切换到控制台。
if (store.get().phase === 'booting') {
  store.patch({ phase: 'unauthenticated' })
}
