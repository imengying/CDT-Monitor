import { App } from '@/App'
import { mustGetById } from '@/lib/dom'
import './style.css'

/**
 * 应用入口。
 *
 * 只做三件事：
 * 1. 注册 401 广播（任意接口返回 401 时立刻切回登录页）；
 * 2. 拿到挂载点；
 * 3. 启动外壳。
 */
const root = mustGetById('app')
const app = new App(root)
app.start()
