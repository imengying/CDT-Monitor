import Worker from '../build/index.js'

// Miniflare 不自动模拟套餐额度；在真实 D1 binding 外统计每次执行的调用次数。
// batch 算一次，prepare/bind 本身不产生数据库调用。
function budget(database) {
  let calls = 0
  function count() {
    if (++calls > 50) throw new Error('Exceeded free-plan D1 invocation budget (50)')
  }
  function statement(value) {
    return new Proxy(value, {
      get(target, key) {
        if (key === 'bind') return (...args) => statement(target.bind(...args))
        if (['first', 'all', 'run', 'raw'].includes(key)) return (...args) => {
          count()
          return target[key](...args)
        }
        const item = target[key]
        return typeof item === 'function' && key !== 'constructor' ? item.bind(target) : item
      },
    })
  }
  return new Proxy(database, {
    get(target, key) {
      if (key === 'prepare') return (...args) => statement(target.prepare(...args))
      if (['batch', 'exec'].includes(key)) return (...args) => {
        count()
        return target[key](...args)
      }
      const item = target[key]
      return typeof item === 'function' && key !== 'constructor' ? item.bind(target) : item
    },
  })
}

export default class BudgetWorker extends Worker {
  constructor(ctx, env) {
    super(ctx, { ...env, DB: budget(env.DB) })
  }
}
