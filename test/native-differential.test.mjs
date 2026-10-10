import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Opt-in integration lane: this is the extracted/installed DSH directory, not
// its node_modules directory or the active ~/.dsh profile. No install occurs.
// DSH_OFFICIAL_ROOT=/path/to/dsh node --test test/native-differential.test.mjs
const officialRoot = process.env.DSH_OFFICIAL_ROOT
const unavailable = !officialRoot && 'set DSH_OFFICIAL_ROOT to an isolated DSH 0.2.0-rc.2 installation'
const repository = fileURLToPath(new URL('../', import.meta.url))
let officialRequire, cordis, Loader, Projection, Policy, LocalSandbox, Subprocess, Terminals
let BashExecutor, PwshExecutor, BashTool, PwshTool, OfficialTerminal, BashPersistent, PwshPersistent
let SelectedPosixTool, SelectedWindowsTool, SelectedTerminal, SelectedPersistent, minimalDescriptions

if (officialRoot) {
  officialRequire = createRequire(join(resolve(officialRoot), 'package.json'))
  // Redirect module resolution only. Upstream Config/apply/defineTool, executors,
  // sandbox, process runtime and PTY registry remain the genuine implementations.
  // Node's test-file isolation prevents these hooks contaminating the mock lane.
  const anchor = pathToFileURL(join(resolve(officialRoot), 'package.json')).href
  registerHooks({ resolve(id, context, next) {
    if (!id.startsWith('@deepseek-ai/')) return next(id, context)
    // next() bypasses this hook; calling require.resolve() here would recurse
    // because synchronous registerHooks also observes CommonJS resolution.
    return next(id, { ...context, parentURL: anchor })
  } })
  for (const name of ['dsh-bash-sandbox', 'dsh-tool-bash', 'dsh-terminal-bash', 'dsh-tool-bash-persistent']) {
    const manifest = JSON.parse(readFileSync(officialRequire.resolve(`@deepseek-ai/${name}/package.json`), 'utf8'))
    assert.equal(manifest.version, '0.2.0-rc.2', 'the differential baseline must use the pinned official release')
  }
  cordis = await import('@deepseek-ai/cordis')
  ;({ Loader } = await import('@deepseek-ai/cordis-plugin-loader'))
  ;({ default: Projection } = await import('@deepseek-ai/dsh-session-projection'))
  ;({ default: Policy } = await import('@deepseek-ai/dsh-sandbox-policy'))
  ;({ default: LocalSandbox } = await import('@deepseek-ai/dsh-sandbox-local'))
  ;({ default: Subprocess } = await import('@deepseek-ai/dsh-subprocess-local'))
  ;({ TerminalSessionService: Terminals } = await import('@deepseek-ai/dsh-terminal'))
  ;({ SandboxBashExecutor: BashExecutor } = await import('@deepseek-ai/dsh-bash-sandbox'))
  ;({ SandboxPwshExecutor: PwshExecutor } = await import('@deepseek-ai/dsh-pwsh-sandbox'))
  BashTool = await import('@deepseek-ai/dsh-tool-bash')
  PwshTool = await import('@deepseek-ai/dsh-tool-pwsh')
  OfficialTerminal = await import('@deepseek-ai/dsh-terminal-bash')
  BashPersistent = await import('@deepseek-ai/dsh-tool-bash-persistent')
  PwshPersistent = await import('@deepseek-ai/dsh-tool-pwsh-persistent')
  const { entryListSchema } = await import('@deepseek-ai/cordis-plugin-include')
  const yaml = officialRequire('js-yaml')
  const webRoot = dirname(officialRequire.resolve('@deepseek-ai/dsh-web-app/package.json'))
  const minimal = yaml.load(readFileSync(join(webRoot, 'presets/minimal.patch.yml'), 'utf8'), { schema: entryListSchema })
  const persistentRows = minimal[0].insert[0].config.plugins.find(row => row.id === 'persistent-shell').config
  minimalDescriptions = Object.fromEntries(persistentRows.filter(row => row.id.startsWith('persistent-'))
    .map(row => [row.id.replace('persistent-', ''), row.config.description]))
  SelectedPosixTool = await import('../tool-posix.mjs')
  SelectedWindowsTool = await import('../tool-windows.mjs')
  SelectedTerminal = await import('../terminal.mjs')
  SelectedPersistent = await import('../persistent.mjs')
}

// Separate apply calls legitimately construct different closures. Compare their
// code and all schema/presentation fields, not meaningless cross-call identity.
function catalog(value) {
  if (typeof value === 'function') return { functionSource: value.toString() }
  if (Array.isArray(value)) return value.map(catalog)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, catalog(item)]))
  return value
}

function registrationContext(selection) {
  const definitions = [], sections = [], cleanups = [], injections = []
  const ctx = {
    definitions, sections, cleanups, injections, unregistrations: 0,
    fiber: { state: 2 },
    shellSelection: { selected: selection },
    shell: { sandboxMode: 'workspace-write' },
    terminals: {},
    sandboxPolicy: {},
    systemPrompt: { section(value) { sections.push(value) }, getSectionOrder() { return 0 } },
    tools: { register(value) { definitions.push(value); return () => { ctx.unregistrations += 1 } } },
    get(name) { return name === 'sandboxPolicy' ? this.sandboxPolicy : undefined },
    effect(setup) { const cleanup = setup(); if (typeof cleanup === 'function') cleanups.push(cleanup); return cleanup },
    inject(names, callback) { injections.push({ names, callback }); return { dispose() {} } },
  }
  return ctx
}

async function releaseRegistration(ctx) {
  for (const cleanup of ctx.cleanups.reverse()) await cleanup()
}

test('native differential: default one-shot registrations match genuine Bash and PowerShell tools', { skip: unavailable }, async () => {
  for (const [official, selected, dialect, shell] of [
    [BashTool, SelectedPosixTool, 'bash', 'bash'], [PwshTool, SelectedWindowsTool, 'pwsh', undefined],
  ]) {
    for (const config of [{}, { enableRunInBackground: false, promoteOnTimeout: false }]) {
      const baseline = registrationContext({ id: 'default', dialect, shell })
      const candidate = registrationContext({ id: 'default', dialect, shell })
      official.apply(baseline, config)
      selected.apply(candidate, config)
      assert.equal(selected.Config, official.Config)
      assert.deepEqual(catalog(candidate.definitions), catalog(baseline.definitions))
      assert.deepEqual(candidate.sections, baseline.sections)
      assert.deepEqual(candidate.injections.map(item => item.names), baseline.injections.map(item => item.names))
      // Exercise the real upstream optional-jobs registration path too.
      for (const context of [baseline, candidate]) {
        const jobContext = { jobs: {}, effect(setup) { const cleanup = setup(); if (typeof cleanup === 'function') this.cleanup = cleanup } }
        for (const injection of context.injections) injection.callback(jobContext)
        jobContext.cleanup?.() // real upstream jobs removal restores foreground registration
      }
      assert.deepEqual(catalog(candidate.definitions), catalog(baseline.definitions))
      assert.equal(candidate.unregistrations, baseline.unregistrations)
      await releaseRegistration(baseline)
      await releaseRegistration(candidate)
    }
  }
})

test('native differential: default registers the exact official backend and preserves authored configuration', { skip: unavailable }, () => {
  for (const dialect of ['bash', 'pwsh']) {
    const config = OfficialTerminal.Config({ shellDialect: dialect, shellPath: process.execPath,
      shellArgs: ['--version'], timeoutMs: 300000, rows: 27, cols: 91, backendType: 'fixture' })
    const baseline = [], candidate = []
    const context = backends => ({ shellSelection: { selected: { id: 'default', dialect, shell: dialect === 'bash' ? 'bash' : undefined } },
      terminals: { registerBackend(value) { backends.push(value) } } })
    OfficialTerminal.apply(context(baseline), config)
    SelectedTerminal.apply(context(candidate), config)
    assert.equal(candidate.length, 1)
    assert.equal(candidate[0].constructor, OfficialTerminal.BashTerminalBackend)
    assert.deepEqual(candidate[0].config, baseline[0].config)
    assert.deepEqual(catalog(candidate[0].createSession), catalog(baseline[0].createSession))
    assert.equal(SelectedTerminal.Config, OfficialTerminal.Config)
  }
})

test('native differential: default persistent registration retains official and custom descriptions', { skip: unavailable }, async () => {
  const nonce = '12345678-1234-4123-8123-123456789abc'
  const frame = `__DSH_PERSISTENT_BASH_END_${nonce}:130`
  assert.equal(normalizeIntentionalSleepTimeout(`unrelated ${nonce}\n${frame}\n[Command timed out or OOM]`),
    `unrelated ${nonce}\n__DSH_PERSISTENT_BASH_END_<official-frame-nonce>:130\n[Command timed out or OOM]`)
  assert.equal(normalizeIntentionalSleepTimeout(`user prefix ${frame}`), `user prefix ${frame}`)
  assert.notEqual(normalizeIntentionalSleepTimeout(frame.replace(':130', ':1')), normalizeIntentionalSleepTimeout(frame))
  for (const [official, dialect, shell] of [[BashPersistent, 'bash', 'bash'], [PwshPersistent, 'pwsh', undefined]]) {
    for (const config of [{ timeoutMs: 300000 },
      { timeoutMs: 300000, description: minimalDescriptions[dialect] },
      { timeoutMs: 240000, description: 'Authored fixture instructions', maxOutputChars: 4321 }]) {
      const baseline = registrationContext({ id: 'default', dialect, shell })
      const candidate = registrationContext({ id: 'default', dialect, shell })
      official.apply(baseline, config)
      SelectedPersistent.apply(candidate, config)
      assert.deepEqual(catalog(candidate.definitions), catalog(baseline.definitions))
      assert.equal(candidate.cleanups.length, baseline.cleanups.length)
      await releaseRegistration(baseline)
      await releaseRegistration(candidate)
    }
  }
})

function fixture(t) {
  const parent = join(repository, '.temp')
  mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(join(parent, 'native-differential-'))
  const workdir = join(root, "O'Reilly workspace"), home = join(root, 'home')
  mkdirSync(workdir); mkdirSync(home)
  writeFileSync(join(home, '.bashrc'), 'export DSH_DIFF_STARTUP=unexpected\n')
  writeFileSync(join(home, '.bash_profile'), 'export DSH_DIFF_STARTUP=unexpected\n')
  const cleanups = []
  t.after(async () => {
    try { for (const cleanup of cleanups.reverse()) await cleanup() }
    finally { rmSync(root, { recursive: true, force: true }) }
  })
  return { root, workdir, home, cleanups }
}

async function mount(ctx, plugin, config = {}) {
  const fiber = ctx.plugin(plugin, config)
  await fiber.await()
  assert.equal(fiber.state, 2, 'the genuine Cordis plugin must activate')
  return fiber
}

async function runtime(t, files, mode, candidate) {
  const ctx = new cordis.Context()
  // Do not forward unknown runtime logs/config objects to a test failure report.
  ctx.logger.exporters.clear()
  files.cleanups.push(async () => { await ctx.fiber.dispose() })
  ctx.reflect.provide('shellSelection', { selected: process.platform === 'win32'
    ? { id: 'default', dialect: 'pwsh' } : { id: 'default', dialect: 'bash', shell: 'bash' } })
  await mount(ctx, Projection)
  await mount(ctx, Policy, { mode, workspaceRoot: files.workdir })
  await mount(ctx, LocalSandbox)
  await mount(ctx, Subprocess)
  const OfficialExecutor = process.platform === 'win32' ? PwshExecutor : BashExecutor
  const config = { cwd: files.workdir, timeoutMs: 4321, maxTimeoutMs: 5000, graceMs: 100 }
  if (candidate) {
    await mount(ctx, Loader, { baseUrl: pathToFileURL(join(repository, 'package.json')).href })
    const id = process.platform === 'win32' ? 'pwsh-sandbox' : 'bash-sandbox'
    const name = process.platform === 'win32' ? '@deepseek-ai/dsh-pwsh-sandbox' : '@deepseek-ai/dsh-bash-sandbox'
    await ctx.loader.root.update([
      { id, name, disabled: true, config },
      { id: 'differential-assembly', name: pathToFileURL(join(repository, 'assembly.mjs')).href, config: { timeoutMs: 999 } },
    ])
    for (const entry of ctx.loader.entries()) if (entry.fiber) await entry.fiber.await()
  } else await mount(ctx, OfficialExecutor, config)
  // Cordis binds service methods (including constructor) through tracking
  // proxies; checking the method reference is not a valid class identity test.
  assert.ok(ctx.shell instanceof OfficialExecutor)
  assert.ok(ctx.registry.has(OfficialExecutor), 'the official executor plugin, not a selected subclass, must own this service')
  assert.equal(ctx.shell.resolve({ command: ':' }).timeoutMs, 4321, 'default must use the official executor row, not assembly config')
  return ctx
}

function publicResult(result) {
  return { exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut,
    stdout: result.stdout.text, stderr: result.stderr.text, sandbox: result.sandbox }
}

async function run(ctx, command, env, timeoutMs) {
  const process = await ctx.shell.execute(ctx.shell.resolve({ command, env, ...(timeoutMs ? { timeoutMs } : {}) }))
  return publicResult(await process.result())
}

function setFixtureEnvironment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  for (const [key, value] of Object.entries(values)) process.env[key] = value
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  } })
}

const posixOnly = process.platform === 'win32' && 'POSIX command/PTY lane; Windows requires its own native runner'

test('native differential: default executes through real subprocess with identical scrubbed environment and exit status',
  { skip: unavailable || posixOnly, timeout: 20000 }, async t => {
    const files = fixture(t)
    setFixtureEnvironment(t, { DSH_DIFF_PARENT_SECRET: 'synthetic-fixture', dsh_diff_ambient: 'synthetic-fixture' })
    const baseline = await runtime(t, files, 'danger-full-access', false)
    const candidate = await runtime(t, files, 'danger-full-access', true)
    const env = { HOME: files.home, PATH: '/usr/bin:/bin', DSH_DIFF_CWD: files.workdir }
    // Print predicates, never values from the ambient environment.
    const command = 'test "${DSH_DIFF_PARENT_SECRET+x}" != x; printf "credential_absent:%s\\n" "$?"; '
      + 'test "${dsh_diff_ambient+x}" != x; printf "harness_absent:%s\\n" "$?"; '
      + 'test "${DSH_DIFF_STARTUP+x}" != x; printf "startup_absent:%s\\n" "$?"; '
      + 'test "$PWD" = "$DSH_DIFF_CWD"; printf "cwd:%s\\n" "$?"; '
      + 'test "$NO_COLOR:$TERM:$PAGER:$GIT_PAGER" = "1:dumb:cat:cat"; printf "defaults:%s\\n" "$?"; '
      + 'printf fixture-stderr >&2; exit 7'
    const before = await run(baseline, command, env), after = await run(candidate, command, env)
    assert.deepEqual(after, before)
    assert.equal(after.exitCode, 7)
    assert.equal(after.stdout, 'credential_absent:0\nharness_absent:0\nstartup_absent:0\ncwd:0\ndefaults:0\n')
    assert.equal(after.stderr, 'fixture-stderr')
    const timeoutBefore = await run(baseline, 'sleep 5', env, 100)
    const timeoutAfter = await run(candidate, 'sleep 5', env, 100)
    assert.deepEqual(timeoutAfter, timeoutBefore)
    assert.equal(timeoutAfter.timedOut, true)
  })

test('native differential: default retains genuine workspace sandbox denial and never writes outside its policy root',
  { skip: unavailable || posixOnly, timeout: 20000 }, async t => {
    const files = fixture(t), outside = join(files.root, 'outside-workspace')
    writeFileSync(outside, 'unchanged')
    const baseline = await runtime(t, files, 'workspace-write', false)
    const candidate = await runtime(t, files, 'workspace-write', true)
    const env = { HOME: files.home, PATH: '/usr/bin:/bin', DSH_DIFF_OUTSIDE: outside }
    const command = 'printf forbidden > "$DSH_DIFF_OUTSIDE"'
    const before = await run(baseline, command, env), after = await run(candidate, command, env)
    assert.deepEqual(after, before)
    assert.notEqual(after.exitCode, 0)
    assert.equal(after.sandbox?.denied, true)
    assert.equal(readFileSync(outside, 'utf8'), 'unchanged')
  })

async function persistentRuntime(t, files, candidate) {
  const ctx = await runtime(t, files, 'danger-full-access', candidate)
  await mount(ctx, Terminals)
  const definitions = []
  ctx.reflect.provide('tools', { register(value) { definitions.push(value); return () => {} } })
  const owners = new Map()
  ctx.reflect.provide('agents', owners)
  const owner = { id: 'native-differential-owner', ctx, session: { id: 'native-differential-session',
    header: { cwd: files.workdir }, seq: 0, inheritedEventCount: 0, snapshotEvents: () => [], eventAt: () => undefined } }
  owners.set(owner.id, owner)
  const terminal = candidate ? SelectedTerminal : OfficialTerminal
  await mount(ctx, terminal, { timeoutMs: 5000, disposeGraceMs: 300, idleSilenceMs: 100, pollIntervalMs: 25 })
  await mount(ctx, candidate ? SelectedPersistent : BashPersistent, { timeoutMs: 3000, description: 'Native differential fixture' })
  assert.equal(definitions.length, 1)
  const execute = command => definitions[0].execute({ command }, { agent: owner, signal: new AbortController().signal })
  return { ctx, owner, execute }
}

async function persistentStage(t, label, action) {
  // Fixed stage labels only: no command text, captured output or ambient env.
  t.diagnostic(`${label}: start`)
  try {
    const result = await action()
    t.diagnostic(`${label}: complete`)
    return result
  } catch (error) {
    const knownTimeout = error?.name === 'TimeoutReason' && error?.code === 'PERSISTENT_BASH_TIMEOUT'
    throw new Error(`${label}: failed${knownTimeout ? ' (PERSISTENT_BASH_TIMEOUT)' : ''}`)
  }
}

function normalizeIntentionalSleepTimeout(text) {
  // Only the no-user-output `sleep 10` timeout uses this normalization. The
  // genuine rc.2 wrapper can leave its END_<randomUUID()>:130 line in partial
  // output after SIGINT. Independent baseline/default calls necessarily use
  // different UUIDv4 nonces; preserve the status, markers and all other bytes.
  // Never apply this to ordinary command output or unrelated UUIDs/fields.
  return text.replace(/^(__DSH_PERSISTENT_BASH_END_)[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(:\d+)(?=\r?$)/gm,
    '$1<official-frame-nonce>$2')
}

async function persistentTimeoutOutcome(execute) {
  try {
    return { kind: 'rendered', text: normalizeIntentionalSleepTimeout(await execute('sleep 10')) }
  } catch (error) {
    // rc.2 can surface its real deadline reason from startSend rather than
    // rendering the timeout branch. Match that official behavior, not a fake
    // success: other errors still fail, and normal commands must never time out.
    if (error?.name !== 'TimeoutReason' || error?.code !== 'PERSISTENT_BASH_TIMEOUT') throw error
    return { kind: 'thrown', name: error.name, code: error.code, timeoutMs: error.timeoutMs }
  }
}

test('native differential: official PTY transport preserves state, resets after timeout, and matches default outcomes',
  { skip: unavailable || posixOnly, timeout: 30000 }, async t => {
    // Missing native bindings are an explicit optional-platform skip. A binding
    // that loads but cannot allocate PTYs is a real failure, never a fake backend.
    try { officialRequire('node-pty') } catch (error) {
      if (/Failed to load native module|Cannot find module/.test(String(error))) return t.skip('matching native node-pty binding is not installed')
      throw error
    }
    const files = fixture(t), nested = join(files.workdir, 'nested')
    mkdirSync(nested)
    setFixtureEnvironment(t, { HOME: files.home })
    const outputs = []
    for (const candidate of [false, true]) {
      const label = candidate ? 'default' : 'official baseline'
      const instance = await persistentStage(t, `${label}/mount`, () => persistentRuntime(t, files, candidate))
      const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
      const first = await persistentStage(t, `${label}/first-state-command`, () =>
        instance.execute(`DSH_DIFF_STATE=alive; cd ${quote(nested)}; printf 'ready\\n'`))
      assert.equal(first, 'ready\n[Command finished with exit code 0]', `${label}/first-state-command output`)
      const second = await persistentStage(t, `${label}/second-state-command`, () =>
        instance.execute(`printf '%s\\n' "$DSH_DIFF_STATE"; test "$PWD" = ${quote(nested)}; printf 'cwd:%s\\n' "$?"; false`))
      assert.equal(second, 'alive\ncwd:0\n[Command finished with exit code 1]', `${label}/second-state-command output`)
      const timeout = await persistentStage(t, `${label}/intentional-timeout`, () => persistentTimeoutOutcome(instance.execute))
      if (timeout.kind === 'rendered') {
        assert.match(timeout.text, /\[Command timed out or OOM\]/, `${label}/intentional-timeout marker`)
        assert.match(timeout.text, /persistent bash shell was reset/, `${label}/intentional-timeout reset marker`)
      } else {
        assert.deepEqual(timeout, { kind: 'thrown', name: 'TimeoutReason', code: 'PERSISTENT_BASH_TIMEOUT', timeoutMs: 3000 })
        t.diagnostic(`${label}/intentional-timeout: genuine upstream deadline reason surfaced`)
      }
      assert.equal(instance.ctx.terminals.list(instance.owner).length, 0, `${label}/intentional-timeout cleanup`)
      const reset = await persistentStage(t, `${label}/reset-command`, () =>
        instance.execute('printf "%s\\n" "${DSH_DIFF_STATE-unset}"'))
      assert.equal(reset, 'unset\n[Command finished with exit code 0]', `${label}/reset-command output`)
      outputs.push({ first, second, timeout, reset })
      await persistentStage(t, `${label}/dispose-terminals`, () => instance.ctx.terminals.disposeAll())
    }
    assert.deepEqual(outputs[1], outputs[0])
  })
