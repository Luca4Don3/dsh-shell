import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

registerHooks({ resolve(id, ctx, next) {
  if (id !== '@deepseek-ai/dsh-agent-preset') return next(id, ctx)
  return { url: `data:text/javascript,${encodeURIComponent(`
    export default class AgentPreset {
      static inject = ['agentPresets']
      static Config = { originalSchema: true }
      static [Symbol.for('preset-loader-marker')] = true
      constructor(ctx, config) { this.ctx = ctx; this.config = config }
    }
  `)}`, shortCircuit: true }
} })
const { default: SelectedPreset, adaptPresetConfig, installPresetSelection } = await import('../preset.mjs')
const config = { id: 'custom', order: 7, description: 'Keep this', plugins: [
  { id: 'persona', name: 'original-persona', config: { instruction: 'Keep this too' } },
  { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: false, config: { enableRunInBackground: false } },
  { id: 'nested', name: 'cordis:group', group: true, isolate: { tools: true }, config: [
    { id: 'nested-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: true },
  ] },
] }

test('Windows preset adaptation replaces nested pwsh registrations and preserves authored settings', () => {
  const result = adaptPresetConfig(config, 'win32')
  assert.equal(result.id, config.id)
  assert.equal(result.description, config.description)
  assert.equal(result.plugins[0], config.plugins[0])
  assert.equal(result.plugins[1].name, 'dsh-shell/tool-windows')
  assert.equal(result.plugins[1].config, config.plugins[1].config)
  assert.deepEqual(result.plugins[2].isolate, { tools: true })
  assert.equal(result.plugins[2].config[0].name, 'dsh-shell/tool-windows')
  assert.equal(result.plugins[2].config[0].disabled, true)
  assert.equal(config.plugins[1].name, '@deepseek-ai/dsh-tool-pwsh')
})

test('POSIX preset configuration stays identical and shipped loader contracts are inherited', () => {
  assert.equal(adaptPresetConfig(config, 'darwin'), config)
  assert.equal(adaptPresetConfig(config, 'linux'), config)
  assert.deepEqual(SelectedPreset.inject, ['agentPresets', 'shellSelection'])
  assert.equal(SelectedPreset.Config.originalSchema, true)
  assert.equal(SelectedPreset[Symbol.for('preset-loader-marker')], true)
})

test('POSIX presets adapt nested Bash registrations without changing the authored configuration', () => {
  const bash = { ...config, plugins: [config.plugins[0],
    { name: '@deepseek-ai/dsh-tool-bash', config: { timeoutMs: 1234 } },
    { group: true, config: [{ name: '@deepseek-ai/dsh-tool-bash', disabled: true }] }] }
  for (const platform of ['darwin', 'linux']) {
    const result = adaptPresetConfig(bash, platform)
    assert.equal(result.plugins[0], bash.plugins[0])
    assert.equal(result.plugins[1].name, 'dsh-shell/tool-posix')
    assert.equal(result.plugins[1].config, bash.plugins[1].config)
    assert.equal(result.plugins[2].config[0].name, 'dsh-shell/tool-posix')
    assert.equal(result.plugins[2].config[0].disabled, true)
    assert.equal(bash.plugins[1].name, '@deepseek-ai/dsh-tool-bash')
  }
})

test('shipped preset patches add a dependency without replacing authored configs', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  for (const id of ['standard', 'ptc', 'cordis', 'minimal']) {
    assert.match(patch, new RegExp(`- id: preset-${id}\\n  name: '@deepseek-ai/dsh-agent-preset'\\n  inject: \\[.*shellSelection`))
  }
  assert.doesNotMatch(patch, /- id: preset-[\w-]+\n(?:[^\n]*\n)*?  config:/)
  assert.doesNotMatch(patch, /plugins:/)
})

test('default preserves complete authored presets by identity on all platforms', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    assert.equal(adaptPresetConfig(config, platform, { id: 'default' }), config)
  }
})

test('manual minimal adaptation preserves user settings and child expressions without mutation', () => {
  const source = { id: 'minimal', extra: 'preserve', plugins: [
    { name: 'persona', config: { custom: 'preserve' } },
    { name: 'cordis:group', group: true, isolate: { terminals: true }, config: [
      { id: 'terminal-pwsh', name: '@deepseek-ai/dsh-terminal-bash', disabled: { __jsExpr: 'platformCheck' },
        config: { shellDialect: 'pwsh', timeoutMs: 321, rows: 20 } },
      { id: 'persistent-pwsh', name: '@deepseek-ai/dsh-tool-pwsh-persistent', config: { description: 'User guide', timeoutMs: 654 } },
    ] },
  ] }
  const before = structuredClone(source)
  const adapted = adaptPresetConfig(source, 'win32', { id: 'pwsh7', dialect: 'pwsh' })
  assert.equal(adapted.plugins[0], source.plugins[0])
  const children = adapted.plugins[1].config
  assert.equal(children[0].name, 'dsh-shell/terminal')
  assert.equal(children[0].disabled, source.plugins[1].config[0].disabled)
  assert.deepEqual(children[0].config, { timeoutMs: 321, rows: 20 })
  assert.equal(children[1].name, 'dsh-shell/persistent')
  assert.equal(children[1].config.description, 'User guide')
  assert.deepEqual(source, before)
})

test('the runtime hook targets only the four official carriers, never custom declarations', () => {
  let hook
  const ctx = { shellSelection: { selected: { id: 'auto' } }, on(name, callback, options) {
    assert.equal(name, 'internal/config'); assert.equal(options.global, true); hook = callback
  } }
  installPresetSelection(ctx)
  const AgentPreset = Object.getPrototypeOf(SelectedPreset)
  const carrier = id => ({ runtime: { callback: AgentPreset },
    entry: { options: { id, name: '@deepseek-ai/dsh-agent-preset', config } } })
  assert.equal(hook.call(carrier('custom'), config, () => config), config)
  const changed = hook.call(carrier('preset-standard'), config, () => config)
  // POSIX leaves this Windows-only fixture untouched; use a native-platform row.
  const fixture = { ...config, plugins: [{ name: process.platform === 'win32'
    ? '@deepseek-ai/dsh-tool-pwsh' : '@deepseek-ai/dsh-tool-bash' }] }
  assert.notEqual(hook.call(carrier('preset-standard'), fixture, () => fixture), fixture)
  ctx.shellSelection.selected = { id: 'default' }
  assert.equal(hook.call(carrier('preset-minimal'), fixture, () => fixture), fixture)
  assert.equal(carrier('preset-standard').entry.options.config, config)
  assert.equal(changed.id, config.id)
})
