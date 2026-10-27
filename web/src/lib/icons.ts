/**
 * 图标集合
 * ============================================================================
 * 只在这里集中 import 具体图标，其它模块引用语义名（如 `icons.refresh`）。
 *
 * 为什么不直接 `import * as icons from 'lucide'`：
 * 命名空间导入会让打包器保留全部 ~2100 个图标。这里按名引入，
 * 配合 Vite 的 tree-shaking 只保留用到的几十个，JS 体积从 400KB+ 降到 20KB 内。
 */

import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bell,
  CalendarClock,
  Check,
  ChevronDown,
  Cloud,
  Cpu,
  KeyRound,
  LayoutDashboard,
  Loader2,
  LogOut,
  Pencil,
  Play,
  Plus,
  Power,
  RefreshCw,
  Send,
  Server,
  ServerCog,
  Settings,
  ShieldCheck,
  Smartphone,
  Trash2,
  X,
  Zap,
} from 'lucide'

/** 图标节点类型（与 lucide 的 `IconNode` 对齐）。 */
export type IconNode = readonly (readonly [string, Record<string, string | number | undefined>])[]

/** 语义化图标表。 */
export const icons = {
  activity: Activity as IconNode,
  alert: AlertTriangle as IconNode,
  chart: BarChart3 as IconNode,
  bell: Bell as IconNode,
  calendar: CalendarClock as IconNode,
  check: Check as IconNode,
  chevronDown: ChevronDown as IconNode,
  cloud: Cloud as IconNode,
  cpu: Cpu as IconNode,
  key: KeyRound as IconNode,
  dashboard: LayoutDashboard as IconNode,
  spinner: Loader2 as IconNode,
  logout: LogOut as IconNode,
  pencil: Pencil as IconNode,
  play: Play as IconNode,
  plus: Plus as IconNode,
  power: Power as IconNode,
  refresh: RefreshCw as IconNode,
  send: Send as IconNode,
  server: Server as IconNode,
  serverCog: ServerCog as IconNode,
  settings: Settings as IconNode,
  shield: ShieldCheck as IconNode,
  phone: Smartphone as IconNode,
  trash: Trash2 as IconNode,
  close: X as IconNode,
  zap: Zap as IconNode,
} as const

export type IconName = keyof typeof icons
