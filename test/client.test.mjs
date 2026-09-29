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
