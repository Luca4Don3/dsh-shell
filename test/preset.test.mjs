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
const { default: SelectedPreset, adaptPresetConfig } = await import('../preset.mjs')
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
  assert.deepEqual(SelectedPreset.inject, ['agentPresets'])
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

test('all shipped one-shot presets route their tool rows through this bundle', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  for (const id of ['standard', 'ptc', 'cordis']) {
    assert.match(patch, new RegExp(`- id: preset-${id}\n  config:`))
  }
  // A preset row keeps its one-shot tool names inside `config.plugins`, which the
  // patch entry map never indexes; reaching them means replacing the whole config.
  // A top-level entry that swaps a row's module by writing `name` is silently
  // skipped by the loader (name is an identity check, never assigned), so assert
  // that none exist and that every preset carries both adapters.
  assert.doesNotMatch(patch, /- id: [\w-]+\n  name: dsh-shell\//)
  assert.equal((patch.match(/dsh-shell\/tool-posix/g) || []).length, 3)
  assert.equal((patch.match(/dsh-shell\/tool-windows/g) || []).length, 3)
})
