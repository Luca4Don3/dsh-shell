import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

const mocks = {
  '@deepseek-ai/schemastery': `
    const field = { default() { return this }, required() { return this } }
    export default { object: () => ({}), string: () => field, number: () => field }
  `,
  '@deepseek-ai/dsh-tool-bash-persistent': `
    export const apply = (_ctx, config) => globalThis.__persistentCalls.push({ dialect: 'bash', config })
  `,
  '@deepseek-ai/dsh-tool-pwsh-persistent': `
    export const apply = (_ctx, config) => globalThis.__persistentCalls.push({ dialect: 'pwsh', config })
  `,
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    const mock = mocks[specifier]
    return mock === undefined ? nextResolve(specifier, context)
      : { url: `data:text/javascript,${encodeURIComponent(mock)}`, shortCircuit: true }
  },
})
globalThis.__persistentCalls = []
const { apply } = await import('../persistent.mjs')

test('bash, zsh and WSL retain the shipped persistent-tool guidance', () => {
  for (const selection of [
    { id: 'auto', dialect: 'bash', shell: 'bash' },
    { id: 'zsh', dialect: 'bash', shell: 'zsh' },
    { id: 'wsl', dialect: 'bash' },
  ]) {
    apply({ shellSelection: { selected: selection } }, {})
    const { dialect, config } = globalThis.__persistentCalls.pop()
    assert.equal(dialect, 'bash')
    for (const phrase of ['XML-escaped', 'mirrors/proxies', 'State is persistent', 'sed -n', 'large amount of output', 'background']) {
      assert.match(config.description, new RegExp(phrase))
    }
    if (selection.id === 'wsl') assert.match(config.description, /inside WSL/)
    if (selection.id === 'zsh') assert.match(config.description, /persistent zsh shell/)
  }
})

test('PowerShell retains native-path guidance and explicit descriptions still win', () => {
  const ctx = { shellSelection: { selected: { id: 'pwsh7', dialect: 'pwsh' } } }
  apply(ctx, {})
  const defaults = globalThis.__persistentCalls.pop()
  assert.equal(defaults.dialect, 'pwsh')
  for (const phrase of ['XML-escaped', 'State is persistent', 'Windows paths', '$env:NAME', 'large amount of output', 'Start-Job']) {
    assert.ok(defaults.config.description.includes(phrase))
  }
  apply(ctx, { description: 'Custom instructions' })
  assert.equal(globalThis.__persistentCalls.pop().config.description, 'Custom instructions')
})
