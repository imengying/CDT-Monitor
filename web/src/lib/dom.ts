/**
 * DOM 工具层
 * ============================================================================
 * 纯 TypeScript 没有模板编译器，因此这里提供一组**类型安全**的小工具，
 * 让组件代码能像写模板一样声明结构，同时保持零运行时依赖：
 *
 * ```ts
 * el('article', { class: 'account-card' },
 *   el('h3', { text: '标题' }),
 *   el('button', { class: 'button button--primary', on: { click: save } }, '保存'),
 * )
 * ```
 *
 * 样式全部是 `style.css` 里的语义类（`.account-card` / `.button` 等），
 * 不使用 utility 框架，因此写什么类名就得到什么效果，没有扫不到就丢样式的风险。
 *
 * 设计取舍：
 * * **不做虚拟 DOM**：控制台的数据更新粒度很粗（整块重渲染），
 *   直接操作 DOM 反而更简单，也能避免引入框架体积。
 * * **绝不使用 innerHTML 拼接用户数据**：所有文本走 `textContent`，
 *   只有明确可信的静态 SVG 才走 `innerHTML`。这消除了 XSS 风险面。
 * * `attrs` 的键若不认识，就按 HTML 属性设置；`on*` 一律走
 *   `addEventListener`，不写内联事件。
 */

import { icons, type IconNode } from './icons'

/** 子节点允许的类型。 */
export type Child = Node | string | number | null | undefined | false

/** 事件监听器映射。 */
export type Listeners = Record<string, (event: Event) => void>

/** 元素属性。 */
export interface ElAttrs {
  class?: string
  /** 事件监听，键名不带 `on` 前缀，例如 `click`、`input`。 */
  on?: Listeners
  /** 文本内容（等价于 textContent，安全）。 */
  text?: string
  /** 其他 HTML 属性 / DOM 属性。 */
  [key: string]: unknown
}

/**
 * 创建元素。
 *
 * @param tag       标签名
 * @param attrs     属性、事件、文本
 * @param children  子节点（字符串会变成文本节点）
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: ElAttrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)

  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue

    if (key === 'class') {
      node.className = String(value)
      continue
    }
    if (key === 'text') {
      node.textContent = String(value)
      continue
    }
    if (key === 'on') {
      for (const [event, handler] of Object.entries(value as Listeners)) {
        node.addEventListener(event, handler)
      }
      continue
    }
    if (key === 'dataset') {
      Object.assign(node.dataset, value as Record<string, string>)
      continue
    }
    if (key === 'style' && typeof value === 'object') {
      Object.assign(node.style, value as Partial<CSSStyleDeclaration>)
      continue
    }
    if (key === 'value' && 'value' in node) {
      ;(node as HTMLInputElement).value = String(value)
      continue
    }
    if (key === 'checked' && 'checked' in node) {
      ;(node as HTMLInputElement).checked = Boolean(value)
      continue
    }
    if (typeof value === 'boolean') {
      if (value) node.setAttribute(key, '')
      continue
    }
    node.setAttribute(key, String(value))
  }

  appendChildren(node, children)
  return node
}

/** 批量追加子节点。 */
function appendChildren(parent: Element, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    parent.append(typeof child === 'string' || typeof child === 'number' ? String(child) : child)
  }
}

/** 清空元素。 */
export function clear(node: Element): void {
  node.replaceChildren()
}

/** 用新内容替换元素子节点。 */
export function replaceChildren(node: Element, ...children: Child[]): void {
  node.replaceChildren()
  appendChildren(node, children)
}

/** 按 id 取元素，缺失时抛错（用于必须存在的挂载点）。 */
export function mustGetById<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) {
    throw new Error(`找不到挂载点 #${id}`)
  }
  return node as T
}

/**
 * SVG 图标容器。
 *
 * `lucide` 提供的是图标「节点定义」（`[tag, attrs][]`），不是组件，
 * 因此这里把它渲染成内联 SVG。宽度/高度默认继承 `1em`，
 * 颜色继承 `currentColor`，可直接用 CSS 控制大小与配色。
 */
export function iconSvg(
  iconNode: readonly (readonly [string, Record<string, string | number | undefined>])[],
  size = 14,
  className = '',
): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', className)
  svg.style.flexShrink = '0'

  for (const [tag, attrs] of iconNode) {
    const child = document.createElementNS('http://www.w3.org/2000/svg', tag)
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined) continue
      child.setAttribute(key, String(value))
    }
    svg.append(child)
  }
  return svg
}

/** Esc 键监听，返回解绑函数。 */
export function onEscape(handler: () => void): () => void {
  const listener = (event: KeyboardEvent) => {
    if (event.key === 'Escape') handler()
  }
  document.addEventListener('keydown', listener)
  return () => document.removeEventListener('keydown', listener)
}

// ---------------------------------------------------------------------------
// 语义化构件
// ---------------------------------------------------------------------------
// 这几个在上面 `el()` 的基础上封装出全站统一的写法，避免每个组件各拼一遍。

/** 小号大写标签。 */
export function eyebrow(text: string): HTMLElement {
  return el('p', { class: 'eyebrow', text })
}

/** 品牌标识：方形图标 + 两行文字。 */
export function brandLockup(centered = false): HTMLElement {
  return el(
    'div',
    { class: `brand-lockup${centered ? ' brand-lockup--center' : ''}` },
    el('span', { class: 'brand-mark' }, iconSvg(icons.cloud, 21)),
    el('b', { text: 'CDT Monitor' }),
  )
}

/** 图标按钮（顶栏与卡片操作区通用）。 */
export function iconButton(options: {
  label: string
  icon: IconNode
  onClick: () => void
  tone?: 'positive' | 'danger'
  disabled?: boolean
  className?: string
  size?: number
}): HTMLButtonElement {
  const button = el('button', {
    class: `icon-button${options.tone ? ` icon-button--${options.tone}` : ''}${options.className ? ` ${options.className}` : ''}`,
    type: 'button',
    'aria-label': options.label,
    // 不用原生 `title`：那个浮层由系统绘制，样式无法跟随主题（黑底白字）
    'data-tip': options.label,
    on: { click: options.onClick },
  }) as HTMLButtonElement
  button.disabled = Boolean(options.disabled)
  button.append(iconSvg(options.icon, options.size ?? 18))
  return button
}

/** 字段容器：大写标签 + 内容。 */
export function field(label: string, ...children: Child[]): HTMLElement {
  // 标签以 `*` 结尾表示必填：渲染时把星号拆出来单独着色
  const required = label.endsWith('*')
  const labelNode = required
    ? el(
        'label',
        {},
        el('span', { text: label.slice(0, -1) }),
        el('i', { class: 'field-required', text: '*', title: '必填' }),
      )
    : el('label', { text: label })
  return el('div', { class: 'field' }, labelNode, ...children)
}

/** 带图标外壳的输入框。 */
export function inputShell(options: {
  icon?: IconNode
  input: HTMLInputElement | HTMLTextAreaElement
  suffix?: string
  wide?: boolean
}): HTMLElement {
  const children: Child[] = []
  if (options.icon) children.push(iconSvg(options.icon, 17))
  children.push(options.input)
  if (options.suffix) children.push(el('span', { class: 'suffix', text: options.suffix }))
  return el('div', { class: 'input-shell' }, ...children)
}

/** 输入框本身（不带外壳样式，靠外层 `.input-shell` 呈现）。 */
export function textInput(options: {
  type?: string
  value?: string
  placeholder?: string
  id?: string
  autocomplete?: string
  min?: number | string
  max?: number | string
  step?: number | string
  spellcheck?: boolean
}): HTMLInputElement {
  return el('input', {
    type: options.type ?? 'text',
    value: options.value ?? '',
    placeholder: options.placeholder ?? '',
    id: options.id ?? '',
    autocomplete: options.autocomplete ?? 'off',
    spellcheck: options.spellcheck === false ? 'false' : undefined,
    min: options.min,
    max: options.max,
    step: options.step,
  }) as HTMLInputElement
}

/** 分段控件。 */
export function segmented<T extends string>(options: {
  value: T
  items: readonly (readonly [T, string])[]
  onChange: (value: T) => void
}): HTMLElement {
  return el(
    'div',
    { class: 'segmented', role: 'group' },
    ...options.items.map(([key, label]) =>
      el(
        'button',
        {
          class: options.value === key ? 'active' : '',
          type: 'button',
          'data-value': key,
          'aria-pressed': String(options.value === key),
          text: label,
          on: { click: () => options.onChange(key) },
        },
      ),
    ),
  )
}

/** 开关行：图标 + 标题 + 滑动开关。 */
export function toggleRow(options: {
  title: string
  icon: IconNode
  checked: boolean
  onChange: (checked: boolean) => void
}): HTMLElement {
  const input = el('input', { type: 'checkbox' }) as HTMLInputElement
  input.checked = options.checked
  input.addEventListener('change', () => options.onChange(input.checked))

  return el(
    'label',
    { class: 'toggle-row' },
    el('span', {}, iconSvg(options.icon, 17)),
    el('b', { text: options.title }),
    input,
    el('i', { class: 'toggle' }, el('em', {})),
  )
}

/** 区块标题：图标方块 + 副标题 + 标题。 */
export function sectionTitle(options: {
  icon: IconNode
  title: string
  subtitle: string
}): HTMLElement {
  return el(
    'div',
    { class: 'section-title' },
    el('span', {}, iconSvg(options.icon, 19)),
    el(
      'div',
      {},
      el('p', { text: options.subtitle }),
      el('h3', { text: options.title }),
    ),
  )
}

/** 空状态块（无交互）。 */
export function subtleEmpty(text: string, icon: IconNode): HTMLElement {
  return el(
    'div',
    { class: 'subtle-empty' },
    iconSvg(icon, 28),
    el('span', { text }),
  )
}
