import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { recordingSubprocess, useOfficialDependencies } from './official-helpers.mjs'

const official = useOfficialDependencies()
const simulatedPlatform = process.env.DSH_NATIVE_ASSEMBLY_PLATFORM
if (simulatedPlatform) {
  assert.equal(simulatedPlatform, 'win32')
  // Only the platform selector is simulated. Cordis, Loader and both official
  // executor implementations remain the real extracted modules.
  Object.defineProperty(process, 'platform', { value: simulatedPlatform })
}

if (official.skip) {
  test('native assembly integration requires the official runtime', { skip: official.skip }, () => {})
} else {
  const { Context, Service } = await import('@deepseek-ai/cordis')
  const { default: Loader, EntryTree, EntryGroup } = await import('@deepseek-ai/cordis-plugin-loader')
  const { SandboxBashExecutor } = await import('@deepseek-ai/dsh-bash-sandbox')
  const { SandboxPwshExecutor } = await import('@deepseek-ai/dsh-pwsh-sandbox')
  const Assembly = await import('../assembly.mjs')
  const windows = process.platform === 'win32'
  const OfficialExecutor = windows ? SandboxPwshExecutor : SandboxBashExecutor
  const nativeId = windows ? 'pwsh-sandbox' : 'bash-sandbox'
  const nativeModule = windows ? '@deepseek-ai/dsh-pwsh-sandbox' : '@deepseek-ai/dsh-bash-sandbox'
  const nativeTimeout = windows ? 120000 : 60000
  const defaultSelection = windows ? { id: 'default', dialect: 'pwsh' }
    : { id: 'default', dialect: 'bash', shell: 'bash' }
  const selectedUrl = new URL('../shell.mjs', import.meta.url).href
  const selectedWindowsUrl = new URL('../shell-windows.mjs', import.meta.url).href
  const baseUrl = new URL('../', import.meta.url).href

  class TestSubtree extends EntryTree {
    static [EntryGroup.key] = true
    constructor(ctx, config) { super(ctx); this.config = config }
    write() {}
    async *[Service.init]() {
      yield () => this.root.stop()
      await this.root.update(this.config)
    }
  }

  function shellProviders(ctx) {
    return Reflect.ownKeys(ctx.reflect.store)
      .map(key => ctx.reflect.store[key]).filter(impl => impl.name === 'shell')
  }

  // ctx.get() deliberately wraps service methods (including constructor) in
  // traceable proxies. Check the registered raw implementation for class identity.
  const rawShell = ctx => shellProviders(ctx)[0]?.value

  async function fixture(options = {}) {
    const ctx = new Context()
    const subprocess = recordingSubprocess()
    const confined = []
    const policy = { mode: 'workspace-write', workspaceRoot: '/isolated-native-workspace' }
    const sandbox = { async confine(argv, effectivePolicy) {
      confined.push({ argv, policy: effectivePolicy })
      return { argv, enforcement: 'test-seam', denialSignatures: [], runnerFailureRules: [] }
    } }
    const sandboxPolicy = { defaultMode: policy.mode, resolve: () => ({ ...policy }) }
    if (options.constructorError) Object.defineProperty(sandboxPolicy, 'defaultMode', {
      get() { throw options.constructorError },
    })
    ctx.provide('subprocess', subprocess)
    ctx.provide('sandboxPolicy', sandboxPolicy)
    if (options.sandbox !== false) ctx.provide('sandbox', sandbox)
    let selection = options.selection ?? defaultSelection
    const selectionFiber = await ctx.plugin({ name: 'test-shell-selection', apply(child) {
      child.provide('shellSelection', { selected: Object.freeze({ ...selection }) })
    } })
    const loadingContext = ctx.extend({ nativeTimeout, nativeWorkingDirectory: '/isolated-native-cwd' })
    await loadingContext.plugin(Loader, { baseUrl })
    ctx.loader.builtins['test-assembly'] = Assembly
    ctx.loader.builtins['test-subtree'] = TestSubtree
    const nativeRow = { id: nativeId, name: nativeModule, disabled: true,
      ...(windows ? {} : { config: { timeoutMs: 60000 } }), ...options.nativeRow }
    const rows = options.rows ?? [nativeRow]
    await ctx.loader.root.update(rows)
    await ctx.loader.await()
    const providerCounts = []
    ctx.on('internal/service', name => {
      if (name === 'shell') providerCounts.push(shellProviders(ctx).length)
    }, { global: true })
    const assemblyRow = { id: 'test-shell-assembly', name: 'cordis:test-assembly',
      config: options.assemblyConfig ?? { timeoutMs: 3456 } }
    await ctx.loader.root.update([...rows, assemblyRow])
    await ctx.loader.await()
    const entry = ctx.loader.resolve(assemblyRow.id)
    return { ctx, subprocess, confined, policy, sandbox, entry, nativeRow, providerCounts,
      async select(next) {
        selection = next
        await selectionFiber.restart()
        await ctx.loader.await()
      },
      async dispose() { await ctx.fiber.dispose() },
    }
  }

  test('default mounts exactly the official class without importing SelectedExecutor', async t => {
    assert.equal(Assembly.Config, undefined)
    assert.ok(!official.resolvedUrls.has(selectedUrl))
    assert.ok(!official.resolvedUrls.has(selectedWindowsUrl))
    const harness = await fixture()
    t.after(() => harness.dispose())
    await harness.entry.fiber.await()
    const shell = harness.ctx.get('shell')
    assert.equal(rawShell(harness.ctx).constructor, OfficialExecutor)
    assert.equal(Object.getPrototypeOf(shell), OfficialExecutor.prototype)
    assert.equal(shell.config.timeoutMs.get(), nativeTimeout)
    assert.equal(shellProviders(harness.ctx).length, 1)
    assert.ok(!official.resolvedUrls.has(selectedUrl))
    assert.ok(!official.resolvedUrls.has(selectedWindowsUrl))
    await harness.entry.fiber.restart()
    await harness.ctx.loader.await()
    assert.equal(rawShell(harness.ctx).constructor, OfficialExecutor)
    assert.equal(shellProviders(harness.ctx).length, 1)
    assert.ok(!official.resolvedUrls.has(selectedUrl))
    assert.ok(harness.providerCounts.every(count => count <= 1))
    await harness.dispose()
    assert.equal(harness.ctx.get('shell'), undefined)
    assert.equal(shellProviders(harness.ctx).length, 0)
  })

  test('native config expressions use the original row context and remain authored raw nodes', async t => {
    const config = { timeoutMs: { __jsExpr: 'nativeTimeout + 7' },
      cwd: { __jsExpr: 'nativeWorkingDirectory' } }
    const authored = structuredClone(config)
    const harness = await fixture({ nativeRow: { config }, assemblyConfig: { timeoutMs: 1 } })
    t.after(() => harness.dispose())
    await harness.entry.fiber.await()
    const shell = harness.ctx.get('shell')
    assert.equal(rawShell(harness.ctx).constructor, OfficialExecutor)
    assert.equal(shell.config.timeoutMs.get(), nativeTimeout + 7)
    assert.equal(shell.config.cwd.get(), '/isolated-native-cwd')
    assert.deepEqual(harness.ctx.loader.resolve(nativeId).options.config, authored)
    assert.deepEqual(config, authored)
    assert.deepEqual(harness.entry.options.config, { timeoutMs: 1 })
  })

  test('default command argv, subprocess envelope and sandbox result match direct official assembly', async t => {
    const harness = await fixture()
    t.after(() => harness.dispose())
    const direct = new Context()
    t.after(() => direct.fiber.dispose())
    const subprocess = recordingSubprocess()
    direct.provide('subprocess', subprocess)
    direct.provide('sandbox', harness.sandbox)
    direct.provide('sandboxPolicy', { defaultMode: harness.policy.mode,
      resolve: () => ({ ...harness.policy }) })
    await direct.plugin(OfficialExecutor, windows ? {} : { timeoutMs: 60000 })
    const request = { command: "printf 'native-test'", workdir: '/isolated-request-cwd',
      onExpiry: 'none', env: { DSH_TEST_LITERAL: 'preserve this value' } }
    const assembled = harness.ctx.get('shell')
    const native = direct.get('shell')
    const result = await (await assembled.execute(assembled.resolve(request))).result()
    const expected = await (await native.execute(native.resolve(request))).result()
    assert.deepEqual(result, expected)
    assert.deepEqual(harness.subprocess.calls, subprocess.calls)
    assert.equal(result.timeoutMs, nativeTimeout)
    assert.equal(result.sandbox.mode, 'workspace-write')
    assert.equal(result.sandbox.denied, false)
    assert.equal(result.sandbox.enforcement, 'test-seam')
    assert.equal(harness.subprocess.calls.length, 1)
    const argv = harness.subprocess.calls[0].argv
    if (windows) {
      assert.equal(argv[0], 'pwsh')
      assert.deepEqual(argv.slice(1, 5), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'])
      assert.ok(argv.at(-1).endsWith(request.command))
    } else assert.deepEqual(argv, ['bash', '-c', request.command])
  })

  test('native composition violations fail explicitly without selecting an alternative executor', async t => {
    const expectedError = /exactly one disabled official|cannot preserve the custom executor scope/
    const cases = [
      ['missing row', { rows: [] }],
      ['wrong official module', { nativeRow: { name: '@deepseek-ai/dsh-bash-local' } }],
      ['enabled official row', { nativeRow: { disabled: false } }],
      ['duplicate id across real Loader trees', { rows: [
        { id: nativeId, name: nativeModule, disabled: true },
        { id: 'duplicate-subtree', name: 'cordis:test-subtree', config: [
          { id: nativeId, name: nativeModule, disabled: true },
        ] },
      ] },
      ],
      ['custom executor scope', { nativeRow: { isolate: { sandboxPolicy: 'custom-executor-scope' } } }],
      ['native row inside a nested group', { rows: [
        { id: 'native-subtree', name: 'cordis:test-subtree', config: [
          { id: nativeId, name: nativeModule, disabled: true,
            ...(windows ? {} : { config: { timeoutMs: 60000 } }) },
        ] },
      ] }],
    ]
    for (const [label, options] of cases) await t.test(label, async st => {
      const harness = await fixture(options)
      st.after(() => harness.dispose())
      await assert.rejects(harness.entry.fiber.await(), expectedError)
      const children = [...harness.ctx.registry.values()].flatMap(runtime => [...runtime.fibers])
        .filter(fiber => fiber.parent.fiber === harness.entry.fiber)
      assert.equal(children.length, 0)
      assert.ok(shellProviders(harness.ctx).length <= 1)
      if (label !== 'enabled official row') assert.equal(harness.ctx.get('shell'), undefined)
    })
  })

  test('an isolated native custom scope and a misplaced native row never run the platform default', async t => {
    for (const [label, options, expectedError] of [
      ['custom executor scope', { nativeRow: { isolate: { sandboxPolicy: 'scoped-executor' } } },
        /cannot preserve the custom executor scope/],
      ['native row inside a nested group', { rows: [{ id: 'native-subtree', name: 'cordis:test-subtree', config: [
        { id: nativeId, name: nativeModule, disabled: true }] }] }, /unmodified scope/],
    ]) {
      await t.test(label, async st => {
        const harness = await fixture(options)
        st.after(() => harness.dispose())
        await assert.rejects(harness.entry.fiber.await(), expectedError)
        assert.equal(harness.ctx.get('shell'), undefined)
        assert.equal(shellProviders(harness.ctx).length, 0)
      })
    }
  })

  test('official schema and constructor errors propagate through assembly with no fallback', async t => {
    await t.test('invalid raw native Config', async st => {
      const harness = await fixture({ nativeRow: { config: { timeoutMs: 'not-a-number' } } })
      st.after(() => harness.dispose())
      await assert.rejects(harness.entry.fiber.await(), /invalid config.*|expected number/s)
      assert.equal(harness.ctx.get('shell'), undefined)
      assert.equal(shellProviders(harness.ctx).length, 0)
    })
    await t.test('a failure after the constructor provides shell rolls back registration', async st => {
      const harness = await fixture({ constructorError: new Error('test-native-constructor-failed') })
      st.after(() => harness.dispose())
      await assert.rejects(harness.entry.fiber.await(), /test-native-constructor-failed/)
      assert.equal(harness.ctx.get('shell'), undefined)
      assert.equal(shellProviders(harness.ctx).length, 0)
    })
  })

  test('assembly remains pending until all real official dependencies are available', async t => {
    const harness = await fixture({ sandbox: false })
    t.after(() => harness.dispose())
    assert.equal(harness.entry.fiber.state, 0)
    assert.equal(harness.ctx.get('shell'), undefined)
    assert.equal(harness.ctx.registry.get(OfficialExecutor), undefined)
    harness.ctx.provide('sandbox', harness.sandbox)
    await harness.ctx.loader.await()
    await harness.entry.fiber.await()
    assert.equal(rawShell(harness.ctx).constructor, OfficialExecutor)
  })

  test('selection restarts switch default, auto and manual without duplicate shell providers', async t => {
    const harness = await fixture()
    t.after(() => harness.dispose())
    const original = rawShell(harness.ctx)
    await harness.select(windows ? { id: 'auto', dialect: 'pwsh' }
      : { id: 'auto', dialect: 'bash', shell: 'bash' })
    const { default: SelectedExecutor } = await import('../shell.mjs')
    assert.equal(rawShell(harness.ctx).constructor, SelectedExecutor)
    assert.equal(harness.ctx.get('shell').config.timeoutMs.get(), 3456)
    assert.notEqual(rawShell(harness.ctx), original)
    assert.equal(shellProviders(harness.ctx).length, 1)
    await harness.select(windows ? { id: 'pwsh7', dialect: 'pwsh', path: '/never-started/pwsh' }
      : { id: 'posix-zsh:test', dialect: 'zsh', shell: 'zsh', path: '/never-started/zsh' })
    assert.equal(rawShell(harness.ctx).constructor, SelectedExecutor)
    assert.equal(shellProviders(harness.ctx).length, 1)
    await harness.entry.fiber.restart()
    await harness.ctx.loader.await()
    assert.equal(rawShell(harness.ctx).constructor, SelectedExecutor)
    await harness.select(defaultSelection)
    assert.equal(rawShell(harness.ctx).constructor, OfficialExecutor)
    assert.equal(harness.ctx.get('shell').config.timeoutMs.get(), nativeTimeout)
    assert.equal(shellProviders(harness.ctx).length, 1)
    assert.ok(harness.providerCounts.every(count => count <= 1))
    assert.ok(!harness.ctx.logger.buffer.some(message =>
      message.args.some(arg => String(arg).includes('has been registered'))))
    await harness.dispose()
    assert.equal(shellProviders(harness.ctx).length, 0)
  })

  const Index = await import('../index.mjs')
  const { default: AgentPreset } = await import('@deepseek-ai/dsh-agent-preset')
  const { entryListSchema, applyEntryPatches } = await import('@deepseek-ai/cordis-plugin-include')
  const requireOfficial = createRequire(join(official.root, 'package.json'))
  const { load: loadYaml } = requireOfficial('js-yaml')

  function declaredPresetRows() {
    return ['standard', 'ptc', 'cordis', 'minimal'].map(id => {
      const text = readFileSync(join(official.root, 'node_modules', '@deepseek-ai',
        'dsh-web-app', 'presets', `${id}.patch.yml`), 'utf8')
      const row = loadYaml(text, { schema: entryListSchema })[0].insert[0]
      return { ...row, config: structuredClone(row.config), inject: ['shellSelection'] }
    })
  }

  function pluginRows(entries) {
    return entries.flatMap(entry => [entry, ...(entry.group && Array.isArray(entry.config)
      ? pluginRows(entry.config) : [])])
  }

  async function presetFixture(shell = 'default', options = {}) {
    const ctx = new Context()
    const registered = new Map()
    const registrations = []
    const sections = []
    ctx.provide('agentPresets', { register(definition) {
      registered.set(definition.id, definition)
      registrations.push(definition)
      return () => {
        if (registered.get(definition.id) === definition) registered.delete(definition.id)
      }
    } })
    ctx.provide('systemPrompt', { section(section) {
      sections.push(section)
      return () => sections.splice(sections.indexOf(section), 1)
    } })
    await ctx.plugin(Loader, { baseUrl })
    ctx.loader.builtins['test-index'] = Index
    const rows = declaredPresetRows()
    // Test a user's modifications to a shipped row as well as a fully custom
    // carrier. This expression would throw if the EntryGroup marker were lost.
    rows[0].config.description = 'User-owned standard preset metadata'
    rows[0].config.plugins.push({ id: 'user-expression', name: 'user-owned-plugin',
      config: { instruction: { __jsExpr: 'ctx.get("must-not-run-in-carrier").value' } } })
    const oneShot = rows[0].config.plugins.find(row =>
      row.name === (windows ? '@deepseek-ai/dsh-tool-pwsh' : '@deepseek-ai/dsh-tool-bash'))
    oneShot.config = { enableRunInBackground: false, promoteOnTimeout: false }
    const custom = { id: 'preset-user-owned', name: '@deepseek-ai/dsh-agent-preset', config: {
      id: 'user-owned', description: 'Do not rewrite my composition', plugins: [
        { id: 'custom-shell', name: '@deepseek-ai/dsh-tool-bash', config: { promoteOnTimeout: false } },
        { id: 'custom-prompt', name: 'user-owned-plugin', config: { text: 'Keep my instructions' } },
      ],
    } }
    const config = options.config ?? { shell }
    const indexRow = { id: 'test-index', name: 'cordis:test-index', config }
    await ctx.loader.root.update([...rows, custom, indexRow])
    await ctx.loader.await()
    const indexEntry = ctx.loader.resolve(indexRow.id)
    await indexEntry.fiber.await()
    for (const row of [...rows, custom]) {
      const entry = ctx.loader.resolve(row.id)
      await entry.fiber.await()
      assert.equal(entry.fiber.runtime.callback, AgentPreset)
    }
    return { ctx, rows, custom, registered, registrations, sections, indexEntry,
      dispose: () => ctx.fiber.dispose() }
  }

  test('real profile patch composition retains native executor configs and user-owned presets', () => {
    const basePatch = loadYaml(readFileSync(join(official.root, 'node_modules', '@deepseek-ai',
      'dsh-base', 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema })
    const base = applyEntryPatches([], basePatch, () => assert.fail('official base patch should compose'))
    const presets = declaredPresetRows()
    // Preserve an existing user's profile config through the bundle layer.
    presets[0].config.description = 'User profile description'
    presets[0].config.plugins.push({ id: 'profile-owned-plugin', name: 'profile-owned-module',
      config: { keep: { __jsExpr: 'ctx.get("profile-owned-fact")' } } })
    const authored = structuredClone([...base, ...presets])
    const patch = loadYaml(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'),
      { schema: entryListSchema })
    const warnings = []
    const result = applyEntryPatches(authored, patch, message => warnings.push(message))
    assert.deepEqual(warnings, [])
    for (const id of ['bash-sandbox', 'pwsh-sandbox']) {
      const original = authored.find(row => row.id === id)
      const composed = result.find(row => row.id === id)
      assert.equal(composed.name, original.name)
      assert.equal(composed.disabled, true)
      assert.deepEqual(composed.config, original.config)
    }
    for (const preset of presets) {
      const composed = result.find(row => row.id === preset.id)
      assert.deepEqual(composed.config, preset.config)
      assert.deepEqual(composed.inject, ['shellSelection'])
    }
    const assembly = result.find(row => row.id === 'selected-shell')
    assert.equal(assembly.name, 'dsh-shell/assembly')
    assert.equal(assembly.config.timeoutMs, 60000)
    assert.deepEqual(authored, [...base, ...presets])
    const userConfig = { id: 'standard', description: 'A later user override', plugins: [
      { id: 'user-only-tool', name: 'user-owned-module', config: { instruction: 'literal text' } },
    ] }
    const overridden = applyEntryPatches(result, [{ id: 'preset-standard', config: userConfig }],
      () => assert.fail('user preset override should compose'))
    assert.deepEqual(overridden.find(row => row.id === 'preset-standard').config, userConfig)
    assert.deepEqual(result.find(row => row.id === 'preset-standard').config, presets[0].config)
  })

  test('real Index and official preset carriers keep native compositions and user raw config unchanged', async t => {
    const harness = await presetFixture()
    t.after(() => harness.dispose())
    assert.equal(harness.ctx.get('shellSelection').selected.id, 'default')
    assert.equal(harness.sections.length, 0)
    assert.equal(harness.registered.size, 5)
    for (const row of [...harness.rows, harness.custom]) {
      const entry = harness.ctx.loader.resolve(row.id)
      assert.deepEqual(entry.options.config, row.config)
      assert.deepEqual(harness.registered.get(row.config.id), row.config)
      assert.ok(!pluginRows(harness.registered.get(row.config.id).plugins)
        .some(plugin => plugin.name.startsWith('dsh-shell/')))
    }
    const minimal = harness.registered.get('minimal')
    const persistent = pluginRows(minimal.plugins).find(row => row.id === 'persistent-shell')
    assert.deepEqual(persistent.isolate, { terminals: true })
    assert.ok(pluginRows(minimal.plugins).filter(row => row.name.includes('persistent'))
      .every(row => row.config.timeoutMs === 300000 && row.config.description))
  })

  test('Auto and Manual adapt only official preset runtime copies and preserve authored overrides', async t => {
    const modes = [{ label: 'Auto', config: { shell: 'auto' } }]
    if (!windows) modes.push({ label: 'Manual', config: { shell: 'bash', shellPath: '/bin/bash' } })
    for (const { label, config } of modes) await t.test(label, async st => {
      const harness = await presetFixture(undefined, { config })
      st.after(() => harness.dispose())
      assert.notEqual(harness.ctx.get('shellSelection').selected.id, 'default')
      assert.equal(harness.sections.length, 1)
      const expectedTool = windows ? 'dsh-shell/tool-windows' : 'dsh-shell/tool-posix'
      for (const row of harness.rows) {
        assert.deepEqual(harness.ctx.loader.resolve(row.id).options.config, row.config)
        const runtime = harness.registered.get(row.config.id)
        if (row.config.id !== 'minimal') {
          const selectedTool = pluginRows(runtime.plugins).find(plugin => plugin.name === expectedTool)
          assert.ok(selectedTool)
          const authoredTool = pluginRows(row.config.plugins).find(plugin =>
            plugin.name === (windows ? '@deepseek-ai/dsh-tool-pwsh' : '@deepseek-ai/dsh-tool-bash'))
          assert.deepEqual(selectedTool.disabled, authoredTool.disabled)
          assert.deepEqual(selectedTool.config, authoredTool.config)
        }
      }
      assert.deepEqual(harness.registered.get('user-owned'), harness.custom.config)
      const standard = harness.registered.get('standard')
      assert.equal(standard.description, 'User-owned standard preset metadata')
      assert.deepEqual(standard.plugins.at(-1), harness.rows[0].config.plugins.at(-1))
      const minimalRows = pluginRows(harness.registered.get('minimal').plugins)
      const backendRows = minimalRows.filter(row => row.name === 'dsh-shell/terminal')
      const persistentRows = minimalRows.filter(row => row.name === 'dsh-shell/persistent')
      assert.equal(backendRows.length, 2)
      assert.equal(persistentRows.length, 2)
      assert.ok([...backendRows, ...persistentRows].every(row => row.config.timeoutMs === 300000))
      assert.deepEqual(minimalRows.find(row => row.id === 'persistent-shell').isolate, { terminals: true })
    })
  })

  test('volatile mode edits retain raw next-start config without hot-switching existing preset registrations', async t => {
    const harness = await presetFixture()
    t.after(() => harness.dispose())
    const selection = harness.ctx.get('shellSelection').selected
    const definitions = new Map(harness.registered)
    const registrationCount = harness.registrations.length
    const fiber = harness.indexEntry.fiber
    await harness.indexEntry.update({ config: { shell: 'auto' } })
    await harness.ctx.loader.await()
    assert.deepEqual(harness.indexEntry.options.config, { shell: 'auto' })
    assert.equal(fiber.config.shell.get(), 'auto')
    assert.equal(harness.indexEntry.fiber, fiber)
    assert.equal(harness.ctx.get('shellSelection').selected, selection)
    assert.equal(harness.ctx.get('shellSelection').selected.id, 'default')
    assert.equal(harness.sections.length, 0)
    assert.equal(harness.registrations.length, registrationCount)
    for (const [id, definition] of definitions) assert.equal(harness.registered.get(id), definition)
  })

  test('index disable/re-enable rejects changed startup selection and cleans up its configuration hook', async t => {
    const harness = await presetFixture()
    t.after(() => harness.dispose())
    const hooks = () => harness.ctx.events._hooks['internal/config'].length
    const activeHooks = hooks()
    await harness.indexEntry.update({ disabled: true })
    await harness.ctx.loader.await()
    assert.equal(harness.ctx.get('shellSelection'), undefined)
    assert.equal(hooks(), activeHooks - 1)
    await harness.indexEntry.update({ disabled: false, config: { shell: 'auto' } })
    await harness.ctx.loader.await()
    await assert.rejects(harness.indexEntry.fiber.await(), /requires restarting DSH.*live switching is not supported/)
    assert.equal(harness.ctx.get('shellSelection'), undefined)
    assert.equal(harness.sections.length, 0)
    assert.equal(hooks(), activeHooks - 1)
    assert.deepEqual(harness.indexEntry.options.config, { shell: 'auto' })
    await harness.indexEntry.update({ config: { shell: 'default' } })
    await harness.ctx.loader.await()
    await harness.indexEntry.fiber.await()
    assert.equal(harness.ctx.get('shellSelection').selected.id, 'default')
    assert.equal(hooks(), activeHooks)
    assert.equal(harness.registered.size, 5)
    // A fresh runtime is a legitimate restart boundary, not a process-global pin.
    const fresh = await presetFixture('auto')
    t.after(() => fresh.dispose())
    assert.notEqual(fresh.ctx.get('shellSelection').selected.id, 'default')
  })

  test('a cache-busted Index HMR replacement retains the same runtime startup pin', async t => {
    const harness = await presetFixture()
    t.after(() => harness.dispose())
    const startupSelection = harness.ctx.get('shellSelection').selected
    await harness.indexEntry.update({ config: { shell: 'auto' } })
    await harness.ctx.loader.await()
    const Replacement = await import('../index.mjs?native-assembly-hmr-replacement')
    assert.notEqual(Replacement.apply, Index.apply)
    const oldFiber = harness.indexEntry.fiber
    harness.ctx.registry.delete(Index)
    await oldFiber.await()
    harness.ctx.loader.builtins['test-index'] = Replacement
    await harness.indexEntry.init()
    await harness.ctx.loader.await()
    await assert.rejects(harness.indexEntry.fiber.await(), /requires restarting DSH.*live switching is not supported/)
    assert.equal(harness.ctx.get('shellSelection'), undefined)
    assert.equal(harness.sections.length, 0)
    assert.deepEqual(harness.indexEntry.options.config, { shell: 'auto' })
    await harness.indexEntry.update({ config: { shell: 'default' } })
    await harness.ctx.loader.await()
    await harness.indexEntry.fiber.await()
    assert.equal(harness.ctx.get('shellSelection').selected, startupSelection)
    assert.equal(harness.registered.size, 5)
  })

  if (!simulatedPlatform && process.platform !== 'win32') {
    test('the same real-core suite passes with the Windows platform selector', () => {
      const result = spawnSync(process.execPath, ['--test', fileURLToPath(import.meta.url)], {
        cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 60000,
        // Do not forward ambient credentials, Profile metadata or runtime env.
        env: { DSH_OFFICIAL_ROOT: official.root, DSH_NATIVE_ASSEMBLY_PLATFORM: 'win32',
          PATH: process.env.PATH ?? '/usr/bin:/bin' },
      })
      assert.equal(result.error, undefined, result.error?.message)
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
      assert.match(result.stdout, /fail 0/)
    })
  }
}
