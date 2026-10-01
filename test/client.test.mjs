import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'

let bundle
runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load(value) { bundle = value } } },
})
const client = bundle.factory((name) => {
  assert.equal(name, 'react')
  return { createElement() {} }
})

test('the client reads only host-provided shell and WSL choices', () => {
  const schema = { uid: 1, refs: {
    1: { type: 'object', dict: { shell: 2, wslDistribution: 6 } },
    2: { type: 'union', list: [3, 4, 5] },
    3: { type: 'const', value: 'auto' },
    4: { type: 'const', value: 'bash' },
    5: { type: 'const', value: 'zsh' },
    6: { type: 'union', list: [7, 8] },
    7: { type: 'const', value: 'Ubuntu' },
    8: { type: 'const', value: 'Debian' },
  } }
  assert.deepEqual(Array.from(client.choices(schema, 'shell')), ['auto', 'bash', 'zsh'])
  assert.deepEqual(Array.from(client.choices(schema, 'wslDistribution')), ['Ubuntu', 'Debian'])
  assert.deepEqual(Array.from(client.choices(schema, 'missing')), [])
})

test('switching shells clears an incompatible custom path', () => {
  const edits = client.operations(
    { shell: 'zsh', shellPath: '/opt/zsh' },
    { shell: 'bash', wslDistribution: '' },
    ['auto', 'bash', 'zsh'], [],
  )
  assert.deepEqual(JSON.parse(JSON.stringify(edits)), [
    { op: 'set', path: ['shell'], value: 'bash' },
    { op: 'set', path: ['shellPath'], value: null },
  ])
})

test('the selected WSL distribution is saved and unavailable choices fail', () => {
  const edits = client.operations(
    { shell: 'wsl', wslDistribution: 'Ubuntu' },
    { shell: 'wsl', wslDistribution: 'Debian' },
    ['auto', 'wsl'], ['Ubuntu', 'Debian'],
  )
  assert.deepEqual(JSON.parse(JSON.stringify(edits)), [
    { op: 'set', path: ['wslDistribution'], value: 'Debian' },
  ])
  const switchAway = client.operations(
    { shell: 'wsl', wslDistribution: 'Ubuntu' },
    { shell: 'pwsh7', wslDistribution: '' },
    ['auto', 'pwsh7', 'wsl'], ['Ubuntu', 'Debian'],
  )
  assert.deepEqual(JSON.parse(JSON.stringify(switchAway)), [
    { op: 'set', path: ['shell'], value: 'pwsh7' },
    { op: 'set', path: ['wslDistribution'], value: null },
  ])
  assert.throws(() => client.operations({}, { shell: 'wsl', wslDistribution: 'Missing' }, ['auto', 'wsl'], ['Ubuntu']))
})

test('the client registers on the bundle detail page while the host serves it', () => {
  let registration
  const ctx = {
    locale: { bind: () => (key) => key, register: () => () => {} },
    configForms: {
      get: () => ({ subscribe() {}, getSnapshot() {} }),
      describe: () => ({ subscribe() {}, getSnapshot() {} }),
      whileServed: (namespaces, register) => {
        assert.deepEqual(Array.from(namespaces), ['dsh-shell'])
        return register()
      },
    },
    slots: {
      inject: (name, register) => {
        assert.equal(name, 'plugins.bundle.config')
        return register()
      },
      register: (options, component) => {
        registration = { options, component }
        return () => {}
      },
    },
    effect: (register) => register(),
  }
  client.apply(ctx)
  assert.equal(registration.options.key, 'dsh-shell')
  assert.equal(typeof registration.component, 'function')
})

test('display labels preserve stable installation ids and original WSL distribution names', () => {
  const schema = { uid: 1, refs: {
    1: { type: 'object', dict: { shell: 2, wslDistribution: 4 } },
    2: { type: 'union', list: [3] },
    3: { type: 'const', value: 'git-bash:123', meta: { description: { en: 'Git Bash · D:\\Tools\\Git' } } },
    4: { type: 'union', list: [5] },
    5: { type: 'const', value: 'Ubuntu Dev', meta: { description: 'Ubuntu Dev · WSL 2 ★' } },
  } }
  assert.deepEqual(JSON.parse(JSON.stringify(client.options(schema, 'shell'))), [{ value: 'git-bash:123', label: 'Git Bash · D:\\Tools\\Git' }])
  assert.deepEqual(Array.from(client.choices(schema, 'wslDistribution')), ['Ubuntu Dev'])
  const edits = client.operations({ shell: 'auto' }, { shell: 'wsl', wslDistribution: 'Ubuntu Dev' }, ['auto', 'wsl'], ['Ubuntu Dev'])
  assert.equal(edits.find(edit => edit.path[0] === 'wslDistribution').value, 'Ubuntu Dev')
})

test('a rejected save reloads the latest configuration so a fresh selection can be saved', async () => {
  const slots = []
  let cursor = 0
  let effects = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useSyncExternalStore: (_subscribe, read) => read(),
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = initial
      return [slots[index], value => { slots[index] = value }]
    },
    useEffect: callback => { effects.push(callback) },
  }
  const module = bundle.factory(() => React)
  let state = { status: 'ready', writable: true, revision: 'first', value: { shell: 'auto' } }
  const schema = { uid: 1, refs: {
    1: { type: 'object', dict: { shell: 2 } },
    2: { type: 'union', list: [3, 4, 5] },
    3: { type: 'const', value: 'auto' }, 4: { type: 'const', value: 'bash' }, 5: { type: 'const', value: 'zsh' },
  } }
  const revisions = []
  const form = { subscribe() {}, getSnapshot: () => state, async mutate(_ops, revision) {
    revisions.push(revision)
    if (revisions.length === 1) {
      state = { ...state, revision: 'latest', value: { shell: 'bash' } }
      return false
    }
    return revision === state.revision
  } }
  let component
  module.apply({
    locale: { bind: () => key => key, register() {} },
    configForms: { get: () => form,
      describe: () => ({ subscribe() {}, getSnapshot: () => ({ view: { namespaces: [{ ns: 'dsh-shell', schema }] } }) }),
      whileServed: (_entries, register) => register(),
    },
    slots: { inject: (_slot, register) => register(), register: (_options, value) => { component = value } },
    effect: register => register(),
  })
  function render() {
    cursor = 0
    effects = []
    const tree = component()
    for (const effect of effects) effect()
    return tree
  }
  function find(tree, type) {
    if (tree?.type === type) return tree
    return tree?.children?.flat(Infinity).map(child => find(child, type)).find(Boolean)
  }
  render()
  find(render(), 'select').props.onChange({ target: { value: 'zsh' } })
  await find(render(), 'button').props.onClick()
  render()
  assert.equal(find(render(), 'select').props.value, 'bash')
  find(render(), 'select').props.onChange({ target: { value: 'zsh' } })
  await find(render(), 'button').props.onClick()
  assert.deepEqual(revisions, ['first', 'latest'])
})
