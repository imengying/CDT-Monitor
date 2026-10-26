/**
 * DOM 工具层
 * ============================================================================
 * 纯 TypeScript 没有模板编译器，因此这里提供一组**类型安全**的小工具，
 * 让组件代码能像写模板一样声明结构，同时保持零运行时依赖：
 *
 * ```ts
 * el('div', { class: 'card p-4' },
 *   el('h2', { class: 'text-sm' }, '标题'),
 *   el('button', { class: 'btn', onclick: () => save() }, '保存'),
 * )
 * ```
 *
 * 设计取舍：
 * * **不做虚拟 DOM**：控制台的数据更新粒度很粗（整块重渲染），
 *   直接操作 DOM 反而更简单，也能避免引入框架体积。
 * * **绝不使用 innerHTML 拼接用户数据**：所有文本走 `textContent`，
 *   只有明确可信的静态 SVG 才走 `innerHTML`。这消除了 XSS 风险面。
 * * `attrs` 的键若不认识，就按 HTML 属性设置；`on*` 一律走
 *   `addEventListener`，不写内联事件。
 */

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
export function appendChildren(parent: Element, children: Child[]): void {
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
