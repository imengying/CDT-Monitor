/**
 * echarts 按需注册
 * ============================================================================
 * 本文件只被 `HistoryModal` 通过动态 `import()` 引入，因此会单独打成一个
 * chunk，不会进入首屏 bundle。
 *
 * 注册哪些模块就只打包哪些：`echarts/core` + `LineChart` + `BarChart` +
 * `GridComponent` + `TooltipComponent` + `CanvasRenderer`，
 * 压缩后约 500 kB（gzip 约 175 kB）。
 *
 * 不要把这些 import 拆成多个 `import()` 并行加载——rolldown 无法跨 chunk
 * 做 tree-shaking，会把整个 echarts 拉进来，体积翻倍。
 */

import * as echarts from 'echarts/core'
import { BarChart, LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, CanvasRenderer])

export default echarts
