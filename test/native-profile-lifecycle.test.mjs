import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { useOfficialDependencies } from './official-helpers.mjs'

// Isolated manifest/composition/rollback checks, not a package-manager install,
// GUI activation, or a claim that pnpm upgrade/rollback has been exercised.
const official = useOfficialDependencies()
if (official.skip) {
  test('profile lifecycle integration requires the official runtime', { skip: official.skip }, () => {})
} else {
  const { evaluatePluginCompatibility, getDshRuntimeVersion, bundlePatchFiles,
    bundlePatchPaths, composeEntries } = await import('@deepseek-ai/dsh-app-boot')
  const { entryListSchema, applyEntryPatches } = await import('@deepseek-ai/cordis-plugin-include')
  const { default: z } = await import('@deepseek-ai/schemastery')
  const repository = fileURLToPath(new URL('../', import.meta.url))
  const requireOfficial = createRequire(join(official.root, 'package.json'))
  const { load } = requireOfficial('js-yaml')
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const yaml = filename => load(readFileSync(filename, 'utf8'), { schema: entryListSchema })
  const officialPackage = name => join(official.root, 'node_modules', '@deepseek-ai', name)
  const packageManifest = directory => JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  const baseDir = officialPackage('dsh-base')
  const webDir = officialPackage('dsh-web-app')
  const baseLayers = bundlePatchPaths(baseDir, packageManifest(baseDir).dsh.bundle).map(yaml)
  const nativePresetPaths = bundlePatchPaths(webDir, packageManifest(webDir).dsh.bundle)
    .filter(filename => /\/presets\/[^/]+\.patch\.yml$/.test(filename))
  assert.equal(nativePresetPaths.length, 4)
  const coreLayers = [...baseLayers, ...nativePresetPaths.map(yaml)]
  const pluginLayers = bundlePatchPaths(repository, manifest.dsh.bundle).map(yaml)

  function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value)
      for (const item of Object.values(value)) freeze(item)
    }
    return value
  }
  function row(entries, id) { return entries.find(entry => entry.id === id) }
  function userLayer(shell = 'auto') {
    const standard = structuredClone(row(composeEntries(coreLayers), 'preset-standard').config)
    standard.description = 'User-owned description survives enable/disable/rollback'
    standard.plugins.push({ id: 'user-owned-instructions', name: 'user-owned-plugin', config: {
      instruction: { __jsExpr: 'ctx.get("user-owned-runtime-fact")' },
    } })
    return [
      { id: 'bash-sandbox', config: { timeoutMs: 43210, maxOutputBytes: { __jsExpr: '65536' } } },
      { id: 'pwsh-sandbox', config: { maxTimeoutMs: 987654, pwshPath: 'C:\\fixture\\pwsh.exe' } },
      { id: 'preset-standard', config: standard },
      { insert: [{ id: 'user-preset', name: '@deepseek-ai/dsh-agent-preset', config: {
        id: 'user-preset', plugins: [{ id: 'user-tool', name: 'user-owned-plugin', config: { preserve: true } }],
      } }] },
      { id: 'dsh-shell', config: shell === 'auto' ? { shell: 'auto' }
        : { shell: 'bash', shellPath: '/isolated-user-selected/bash' } },
    ]
  }
  function compose(enabled, authored, warnings = []) {
    return composeEntries([...coreLayers, ...(enabled ? pluginLayers : []), authored],
      message => warnings.push(message))
  }

  test('the current install manifest is accepted on rc.2 and rejected on rc.1 by official compatibility policy', () => {
    const original = structuredClone(manifest)
    assert.equal(getDshRuntimeVersion(), '0.2.0-rc.2')
    assert.equal(manifest.peerDependencies['@deepseek-ai/dsh'], '0.2.0-rc.2')
    assert.equal(evaluatePluginCompatibility(manifest), undefined)
    assert.equal(evaluatePluginCompatibility(manifest, {}, '0.2.0-rc.2'), undefined)
    const rejected = evaluatePluginCompatibility(manifest, {}, '0.2.0-rc.1')
    assert.deepEqual(rejected, { name: manifest.name, version: manifest.version,
      runtimeVersion: '0.2.0-rc.1', peers: { '@deepseek-ai/dsh': '0.2.0-rc.2' }, exempted: false })
    assert.deepEqual(manifest, original)
    assert.equal(manifest.exports['./assembly'], './assembly.mjs')
    assert.ok(manifest.files.includes('assembly.mjs'))
    for (const patch of bundlePatchFiles(manifest.dsh.bundle)) {
      assert.ok(manifest.files.includes(patch.replace(/^\.\//, '')))
    }
  })

  test('official bundle metadata resolves ordered patch files without mutating declarations', () => {
    const declaration = freeze(structuredClone(manifest.dsh.bundle))
    assert.deepEqual(bundlePatchFiles(declaration), ['./cordis.patch.yml'])
    assert.deepEqual(bundlePatchPaths(repository, declaration), [join(repository, 'cordis.patch.yml')])
    const multiple = freeze({ patch: ['./first.patch.yml', './second.patch.yml'] })
    assert.deepEqual(bundlePatchFiles(multiple), multiple.patch)
    assert.deepEqual(bundlePatchPaths('/isolated-bundle', multiple),
      ['/isolated-bundle/first.patch.yml', '/isolated-bundle/second.patch.yml'])
    assert.deepEqual(multiple.patch, ['./first.patch.yml', './second.patch.yml'])
    assert.throws(() => bundlePatchFiles({ patch: 123 }), /must be a file path/)
    assert.throws(() => bundlePatchPaths(repository, { patch: ['./valid.yml', null] }), /must be a file path/)
    const sequential = pluginLayers.reduce((entries, patches) => applyEntryPatches(entries, patches,
      () => assert.fail('a declared bundle patch should resolve its targets')), composeEntries(coreLayers))
    assert.deepEqual(sequential, composeEntries([...coreLayers, ...pluginLayers]))
  })

  test('adding, disabling, removing, and re-adding the bundle recomposes from source without mutating user config', () => {
    for (const mode of ['auto', 'manual']) {
      const authored = freeze(userLayer(mode))
      const snapshot = structuredClone(authored)
      const baseline = compose(false, authored)
      const first = compose(true, authored)
      const disabled = compose(false, authored)
      const removed = compose(false, authored)
      const readded = compose(true, authored)
      assert.deepEqual(disabled, baseline)
      assert.deepEqual(removed, baseline)
      assert.deepEqual(readded, first)
      assert.deepEqual(authored, snapshot)
      for (const entries of [first, readded]) {
        assert.equal(row(entries, 'selected-shell').name, 'dsh-shell/assembly')
        assert.deepEqual(row(entries, 'dsh-shell').config, authored.at(-1).config)
        assert.equal(row(entries, 'bash-sandbox').disabled, true)
        assert.equal(row(entries, 'pwsh-sandbox').disabled, true)
        for (const id of ['bash-sandbox', 'pwsh-sandbox', 'preset-standard', 'user-preset']) {
          assert.deepEqual(row(entries, id).config, row(baseline, id).config)
        }
        for (const id of ['standard', 'ptc', 'minimal', 'cordis']) {
          assert.deepEqual(row(entries, `preset-${id}`).inject, ['shellSelection'])
          assert.deepEqual(row(entries, `preset-${id}`).config, row(baseline, `preset-${id}`).config)
        }
        assert.equal(new Set(entries.map(entry => entry.id)).size, entries.length)
      }
      for (const entries of [disabled, removed]) {
        assert.equal(row(entries, 'selected-shell'), undefined)
        assert.equal(row(entries, 'dsh-shell'), undefined)
        assert.deepEqual(row(entries, 'bash-sandbox').disabled, row(baseline, 'bash-sandbox').disabled)
        assert.deepEqual(row(entries, 'pwsh-sandbox').disabled, row(baseline, 'pwsh-sandbox').disabled)
      }
    }
  })

  test('bundle order is explicit: a later user layer wins, and premature preset patches warn rather than mutate authored data', () => {
    const authored = freeze(userLayer('manual'))
    const before = structuredClone(authored)
    const laterLayer = [{ id: 'preset-standard', config: {
      id: 'standard', plugins: [{ id: 'later-user-only', name: 'later-user-tool' }],
    } }]
    const result = composeEntries([...coreLayers, ...pluginLayers, authored, laterLayer])
    assert.deepEqual(row(result, 'preset-standard').config, laterLayer[0].config)
    assert.deepEqual(row(result, 'dsh-shell').config, authored.at(-1).config)
    const warnings = []
    const premature = composeEntries([...baseLayers, ...pluginLayers,
      ...nativePresetPaths.map(yaml), authored], message => warnings.push(message))
    assert.equal(warnings.filter(message => /preset-.*not found/.test(message)).length, 4)
    assert.equal(row(premature, 'preset-minimal').inject, undefined)
    assert.deepEqual(row(premature, 'preset-standard').config, authored[2].config)
    assert.deepEqual(authored, before)
  })

  // Read a pinned pre-change Git blob into memory only. Do not install or import
  // the old package, write fixtures, touch a profile, or execute its apply body.
  const legacyCommit = process.env.DSH_SHELL_LEGACY_COMMIT ?? 'f739572a68a6ac7fef1849342783de7643af1eaa'
  const legacy = spawnSync('git', ['show', `${legacyCommit}:index.mjs`],
    { cwd: repository, encoding: 'utf8', timeout: 10000 })
  const legacyUnavailable = legacy.error || legacy.status !== 0
    ? 'the pinned v0.2 baseline is unavailable (for example in a shallow checkout)' : false
  test('the old and new Config declarations accept Auto/Manual; native Default cannot silently roll back to the old schema',
    { skip: legacyUnavailable }, () => {
      const schemaExpression = source => {
        const match = source.match(/export const Config = ([\s\S]*?)\n\}\)/)
        assert.ok(match, 'the reviewed Config declaration must be present')
        return `${match[1]}\n})`
      }
      const inventory = [
        { id: 'posix-bash:fixture', shell: 'bash', label: 'Fixture Bash' },
        { id: 'posix-zsh:fixture', shell: 'zsh', label: 'Fixture Zsh' },
        { id: 'powershell', label: 'Fixture PowerShell' },
        { id: 'wsl', label: 'Fixture WSL' },
      ]
      const declaration = source => runInNewContext(schemaExpression(source),
        { z, installedShells: inventory, wslDistributions: [], distributionLabel: item => item.name },
        { timeout: 1000 })
      const oldSchema = declaration(legacy.stdout)
      const newSchema = declaration(readFileSync(new URL('../index.mjs', import.meta.url), 'utf8'))
      const validate = (schema, config) => schema['~standard'].validate(structuredClone(config))
      for (const input of [{}, { shell: 'auto' }, { shell: 'bash', shellPath: '/fixture/bash' },
        { shell: 'posix-zsh:fixture', shellPath: '/fixture/zsh' },
        { shell: 'powershell', shellPath: 'C:\\fixture\\powershell.exe' },
        { shell: 'wsl', wslDistribution: 'Fixture Distro' }]) {
        const oldResult = validate(oldSchema, input)
        const newResult = validate(newSchema, input)
        assert.equal(oldResult.issues, undefined)
        assert.equal(newResult.issues, undefined)
        for (const key of ['shell', 'shellPath', 'wslDistribution']) {
          assert.equal(newResult.value[key].get(), oldResult.value[key].get())
        }
      }
      const native = { shell: 'default' }
      assert.equal(validate(newSchema, native).issues, undefined)
      assert.ok(validate(oldSchema, native).issues?.length > 0)
      assert.deepEqual(native, { shell: 'default' })
    })
}
