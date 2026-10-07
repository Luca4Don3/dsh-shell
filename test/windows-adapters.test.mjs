import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

const injectedPrompt = 'printf "\\033]133;D;%s\\007" "$?"; PS1="dsh> "'

const mocks = {
  '@deepseek-ai/dsh-subprocess': `
    export const scrubbedParentEnv = () => ({ CUSTOM_HOST: 'ambient', Path: 'C:\\\\Tools;C:\\\\Windows',
      HOME: 'C:\\\\dsh-test-home', WSLENV: 'HOME/p:Path/pl' })
  `,
  '@deepseek-ai/dsh-pwsh-sandbox': `
    export class SandboxPwshExecutor {
      static inject = ['subprocess', 'sandbox', 'sandboxPolicy']
      constructor(ctx, config) { this.ctx = ctx; this.config = config }
      get pwshPath() { return 'native-pwsh.exe' }
      argv(spec) { return [this.pwshPath, '-Command', spec.command] }
      resolve(request) { return { timeoutMs: 60000, workdir: 'C:\\\\workspace', sandboxPolicy: { mode: 'danger-full-access' }, ...request } }
      spawnSpec(spec, stdoutMaxBytes, signal, argv) {
        return { argv, signal, env: { NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat', ...spec.env, ...spec.dshEnv } }
      }
      async execute(spec) {
        const argv = this.argv(spec)
        globalThis.__executions.push({ spec, argv, spawn: this.spawnSpec(spec, spec.stdoutMaxBytes, spec.signal, argv) })
        return { result: async () => globalThis.__response(spec) }
      }
    }
  `,
  '@deepseek-ai/dsh-bash-sandbox': `
    export class SandboxBashExecutor {
      static inject = ['subprocess', 'sandbox', 'sandboxPolicy']
      constructor(ctx) { this.ctx = ctx }
      async execute(spec) { globalThis.__posixExecutions.push(spec); return spec }
    }
  `,
  '@deepseek-ai/dsh-tool-pwsh': `
    export const name = 'tool-pwsh'
    export const inject = ['tools', 'shell', 'systemPrompt']
    export const Config = {}
    export function apply(ctx, config) {
      globalThis.__toolContext = ctx
      ctx.get('sandboxPolicy')
      const dispose = ctx.tools.register(globalThis.__definition)
      ctx.inject(['jobs'], jobCtx => {
        dispose()
        const unregister = ctx.tools.register(globalThis.__jobDefinition)
        jobCtx.effect(() => unregister)
      })
    }
  `,
  '@deepseek-ai/dsh-tool-bash': `
    export { name, inject, Config, apply } from '@deepseek-ai/dsh-tool-pwsh'
  `,
  '@deepseek-ai/dsh-terminal-bash': `
    export const Config = value => value
    export function apply(ctx, config) {
      if (config.timeoutMs === -1) throw new Error('terminal-bash: timeoutMs must be a positive safe integer')
      const resolved = { ...config,
        shellPath: config.shellPath || 'shipped-default-shell.exe',
        shellArgs: config.shellArgs?.length ? config.shellArgs : ['shipped-default-args'] }
      globalThis.__terminalResolved = resolved
      ctx.terminals.registerBackend(new BashTerminalBackend(ctx, resolved))
    }
    export class BashTerminalBackend {
      constructor(ctx, config, spawnTerminal = spec => ctx.subprocess.spawnTerminal(spec)) {
        this.ctx = ctx; this.config = config; this.spawnTerminal = spawnTerminal
      }
      async spawn(spec) {
        const policy = this.ctx.sandboxPolicy.resolve({ session: spec.owner.session })
        let argv = [this.config.shellPath, ...this.config.shellArgs]
        if (policy.mode !== 'danger-full-access') argv = (await this.ctx.sandbox.confine(argv, policy, spec.signal)).argv
        return this.spawnTerminal({ argv, cwd: spec.cwd ?? policy.workspaceRoot,
          env: { DSH_SESSION_ID: 'session', TERM: 'dumb', PROMPT_COMMAND: ${JSON.stringify(injectedPrompt)} } })
      }
      createSession(terminal, config) {
        return { terminal, config, requests: [],
          startSend(request) { this.requests.push(request); return { done: Promise.resolve() } },
          async initialize(signal) { await this.startSend({ text: '', submit: false, signal }).done } }
      }
    }
  `,
}
registerHooks({ resolve(id, context, next) {
  return id in mocks ? { url: `data:text/javascript,${encodeURIComponent(mocks[id])}`, shortCircuit: true } : next(id, context)
} })
const { SelectedWindowsExecutor } = await import('../shell-windows.mjs')
const { SelectedPosixExecutor } = await import('../shell.mjs')
const tool = await import('../tool-windows.mjs')
const posixTool = await import('../tool-posix.mjs')
const terminal = await import('../terminal.mjs')
const wsl = { id: 'wsl', dialect: 'bash', path: 'wsl.exe', distribution: 'Debian', supportsCd: false }
const git = { id: 'git-bash:test', runtime: 'git-bash', dialect: 'bash', path: 'C:\\Tools\\Git\\bin\\bash.exe' }
const baseSpec = { command: 'printf user-command', workdir: 'C:\\workspace', timeoutMs: 60000,
  sandboxPolicy: { mode: 'danger-full-access' }, dshEnv: { DSH_SESSION_ID: 'session' } }
function executor(selection) {
  globalThis.__executions = []
  globalThis.__response = spec => ({ exitCode: 0, stdout: { text: spec.bashProbe
    ? `__DSH_BASH_RUNTIME__5.2\n__DSH_BASH_OS__${selection.id === 'wsl' ? 'Linux' : 'MINGW64_NT-10.0'}\n` : 'user-result' }, stderr: { text: '' } })
  return new SelectedWindowsExecutor({ shellSelection: { selected: selection } }, {})
}

test('WSL rejection happens before probes or user commands; invalid Linux workdir also fails before spawn', async () => {
  const selected = executor(wsl)
  await assert.rejects(selected.execute({ ...baseSpec, sandboxPolicy: { mode: 'workspace-write' } }), /cannot be confined/)
  await assert.rejects(selected.execute({ ...baseSpec, workdir: '/linux-test-home' }), /absolute Windows path/)
  assert.equal(globalThis.__executions.length, 0)
})

test('successful Bash capabilities are cached, while policy, environment and user command remain intact', async () => {
  const selected = executor(wsl)
  await selected.execute(baseSpec)
  await selected.execute({ ...baseSpec, command: 'pwd' })
  assert.equal(globalThis.__executions.length, 3)
  assert.equal(globalThis.__executions[0].spec.bashProbe, true)
  assert.equal(globalThis.__executions[0].spec.onExpiry, 'kill')
  assert.equal(globalThis.__executions[1].argv.at(-1), baseSpec.command)
  assert.equal(globalThis.__executions[1].spec.sandboxPolicy, baseSpec.sandboxPolicy)
  assert.ok(globalThis.__executions[1].spawn.env.WSLENV.includes('DSH_SESSION_ID'))
  await assert.rejects(selected.execute({ ...baseSpec, sandboxPolicy: { mode: 'read-only' } }), /cannot be confined/)
  assert.equal(globalThis.__executions.length, 3)
})

test('WSL forwards the final DSH environment, retaining explicit overrides and WSLENV flags', async () => {
  const selected = executor(wsl)
  await selected.execute({ ...baseSpec, env: { TERM: 'custom-term', PAGER: 'less' },
    dshEnv: { DSH_SESSION_ID: 'session', WSLENV: 'DSH_SESSION_ID/u:EXISTING/p' } })
  for (const { spawn } of globalThis.__executions) {
    assert.equal(spawn.env.TERM, 'custom-term')
    assert.equal(spawn.env.PAGER, 'less')
    assert.equal(spawn.env.NO_COLOR, '1')
    assert.equal(spawn.env.CUSTOM_HOST, 'ambient')
    assert.equal(spawn.env.DSH_SHELL_WINDOWS_PATH, 'C:\\Tools;C:\\Windows')
    assert.ok(!spawn.env.WSLENV.split(':').some(entry => /^(home|path)\//i.test(entry)))
    assert.equal(spawn.env.AMBIENT_API_TOKEN, undefined)
    for (const entry of ['TERM', 'PAGER', 'GIT_PAGER', 'NO_COLOR', 'DSH_SESSION_ID/u', 'EXISTING/p']) {
      assert.ok(spawn.env.WSLENV.split(':').includes(entry), `${entry} must reach WSL`)
    }
  }
})

test('a missing Bash prevents user execution, and a later successful retry is not poisoned by the failed probe', async () => {
  const selected = executor(wsl)
  globalThis.__response = () => ({ exitCode: 1, stdout: { text: '' }, stderr: { text: 'No such file or directory' } })
  await assert.rejects(selected.execute(baseSpec), /No such file/)
  assert.equal(globalThis.__executions.length, 1)
  assert.equal(selected.bashCapabilities, undefined)
  globalThis.__response = () => ({ exitCode: 0, stdout: { text: '__DSH_BASH_RUNTIME__5.2\n__DSH_BASH_OS__Linux\n' }, stderr: { text: '' } })
  await selected.execute(baseSpec)
  assert.equal(globalThis.__executions.length, 3)
})

test('native Bash retains its confined policy for both probe and actual execution', async () => {
  const selected = executor(git)
  const policy = { mode: 'workspace-write' }
  await selected.execute({ ...baseSpec, sandboxPolicy: policy })
  assert.equal(globalThis.__executions.length, 2)
  assert.ok(globalThis.__executions.every(call => call.spec.sandboxPolicy === policy))
  assert.ok(globalThis.__executions.every(call => call.argv[0] === git.path))
})

test('Windows auto keeps the shipped PowerShell route without a Bash probe', async () => {
  const selected = executor({ id: 'auto', dialect: 'pwsh' })
  await selected.execute(baseSpec)
  assert.equal(globalThis.__executions.length, 1)
  assert.deepEqual(globalThis.__executions[0].argv, ['native-pwsh.exe', '-Command', baseSpec.command])
})

test('POSIX auto still sends the exact original spec to DSH and zsh retains command quoting', async () => {
  globalThis.__posixExecutions = []
  await new SelectedPosixExecutor({ shellSelection: { selected: { id: 'auto', shell: 'bash' } } }, {}).execute(baseSpec)
  assert.equal(globalThis.__posixExecutions[0], baseSpec)
  await new SelectedPosixExecutor({ shellSelection: { selected: { id: 'zsh', shell: 'zsh', path: '/bin/zsh' } } }, {}).execute({ command: "printf '%s' 'quoted'" })
  assert.match(globalThis.__posixExecutions[1].command, /^exec '\/bin\/zsh' '-l' '-i' '-c' /)
})

test('tool adaptation changes only guidance and keeps validation, execution and job lifecycle callbacks', () => {
  const definition = Object.freeze({ name: 'pwsh', description: 'PowerShell',
    parameters: { type: 'object', properties: { command: { type: 'string' }, workdir: { type: 'string' } } },
    execute() {}, validate() {}, output: { schema: {}, render() {} } })
  globalThis.__definition = definition
  globalThis.__jobDefinition = { ...definition, execute() {} }
  const registered = []
  const tools = { register(value) { assert.equal(this, tools); registered.push(value); return () => {} } }
  let injectCallback
  const ctx = { tools, shellSelection: { selected: wsl }, get() { assert.equal(this, ctx) },
    inject(_names, callback) { assert.equal(this, ctx); injectCallback = callback } }
  tool.apply(ctx, {})
  injectCallback({ effect() {} })
  assert.equal(registered.length, 2)
  assert.equal(registered[0].execute, definition.execute)
  assert.equal(registered[0].validate, definition.validate)
  assert.equal(registered[0].output, definition.output)
  assert.equal(registered[1].execute, globalThis.__jobDefinition.execute)
  assert.match(registered[0].parameters.properties.command.description, /Bash/)
  assert.match(registered[0].parameters.properties.workdir.description, /Windows host/)
  assert.equal(definition.description, 'PowerShell')
  assert.equal(ctx.tools, tools)
  assert.equal(registered[0].name, 'pwsh')
})

function terminalContext(selection, mode = 'danger-full-access', config = {}) {
  const calls = []
  const policy = { mode, workspaceRoot: 'C:\\workspace' }
  const ctx = { shellSelection: { selected: selection }, terminals: { registerBackend(backend) { ctx.backend = backend } },
    sandboxPolicy: { resolve: () => policy },
    shell: { resolve: spec => ({ timeoutMs: 60000, ...spec }), verifyBash: async spec => { calls.push({ probe: spec }) } },
    sandbox: { confine: async (argv, resolved) => { calls.push({ confinement: resolved }); return { argv: ['sandbox.exe', ...argv] } } },
    subprocess: { spawnTerminal: spec => { calls.push({ spawn: spec }); return spec } },
  }
  terminal.apply(ctx, config)
  return { ctx, calls }
}

test('persistent Bash and PowerShell inherit the shipped terminal default resolution', async () => {
  for (const selection of [
    { id: 'auto', dialect: 'bash', shell: 'bash', path: '/bin/bash' },
    { id: 'pwsh7', dialect: 'pwsh', path: 'selected-pwsh.exe' },
    { id: 'auto', dialect: 'pwsh' },
  ]) {
    const { ctx } = terminalContext(selection)
    assert.equal(ctx.backend.config, globalThis.__terminalResolved)
    const spec = await ctx.backend.spawn({ owner: { session: {} } })
    assert.deepEqual(spec.argv, [selection.path ?? 'shipped-default-shell.exe', 'shipped-default-args'])
  }
})

test('selected terminals retain the shipped startup validation', () => {
  assert.throws(() => terminalContext(wsl, 'danger-full-access', { timeoutMs: -1 }),
    /terminal-bash: timeoutMs must be a positive safe integer/)
})

test('WSL persistent startup checks policy, uses each terminal cwd, and keeps Linux Bash framing', async () => {
  const denied = terminalContext(wsl, 'read-only')
  await assert.rejects(denied.ctx.backend.spawn({ owner: { session: {} } }), /cannot be confined/)
  assert.equal(denied.calls.length, 0)
  const { ctx, calls } = terminalContext(wsl)
  const spec = await ctx.backend.spawn({ cwd: 'D:\\project with spaces', owner: { session: {} } })
  assert.equal(calls[0].probe.workdir, 'D:\\project with spaces')
  assert.equal(spec.cwd, 'D:\\project with spaces')
  assert.equal(spec.argv[0], wsl.path)
  assert.match(spec.argv.at(-2), /133;D/)
  assert.ok(spec.env.WSLENV.includes('DSH_SESSION_ID'))
  assert.equal(spec.env.DSH_SHELL_INJECTED_PROMPT, injectedPrompt)
  assert.ok(spec.env.WSLENV.split(':').includes('DSH_SHELL_INJECTED_PROMPT'))
  assert.equal(spec.env.CUSTOM_HOST, 'ambient')
  assert.ok(spec.env.WSLENV.split(':').includes('DSH_SHELL_WINDOWS_PATH/pl'))
})

test('native persistent startup passes through the existing sandbox before spawning', async () => {
  const { ctx, calls } = terminalContext(git, 'workspace-write')
  const spec = await ctx.backend.spawn({ owner: { session: {} } })
  assert.equal(calls[1].confinement.mode, 'workspace-write')
  assert.equal(spec.argv[0], 'sandbox.exe')
  assert.equal(spec.argv[1], git.path)
  assert.equal(spec.env.DSH_SHELL_INJECTED_PROMPT, injectedPrompt)
})

test('POSIX tool guidance uses the selected syntax without replacing lifecycle callbacks', () => {
  const definition = { name: 'bash', description: 'Bash', execute() {}, validate() {},
    output: { render() {} }, parameters: { properties: { command: { type: 'string' }, workdir: { type: 'string' } } } }
  for (const shell of ['fish', 'tcsh', 'dash', 'zsh']) {
    const adapted = posixTool.adaptPosixTool(definition, { shell })
    assert.equal(adapted.execute, definition.execute)
    assert.equal(adapted.validate, definition.validate)
    assert.equal(adapted.output, definition.output)
    assert.equal(adapted.parameters.properties.workdir, definition.parameters.properties.workdir)
    assert.ok(adapted.parameters.properties.command.description.includes(shell === 'tcsh' ? 'C shell' : shell === 'dash' ? 'POSIX' : shell))
  }
  globalThis.__definition = definition
  const registered = []
  const ctx = { tools: { register(value) { registered.push(value); return () => {} } },
    get() {}, inject() {}, shellSelection: { selected: { id: 'auto', shell: 'bash' } } }
  posixTool.apply(ctx, {})
  assert.equal(registered[0], definition)
  ctx.shellSelection.selected = { id: 'fish', shell: 'fish' }
  posixTool.apply(ctx, {})
  assert.match(registered[1].description, /fish syntax/)
})

test('POSIX terminal sessions receive isolated cwd setup after original-shell environment loading', async () => {
  const selection = { id: 'dash', shell: 'dash', dialect: 'posix', path: '/bin/dash',
    environmentShell: { shell: 'zsh', path: '/bin/zsh' } }
  const { ctx } = terminalContext(selection, 'workspace-write')
  const terminals = await Promise.all(['/first workspace', "/second O'Reilly !workspace"].map(cwd =>
    ctx.backend.spawn({ cwd, owner: { session: {} } })))
  for (let index = 0; index < terminals.length; index++) {
    assert.equal(terminals[index].argv[0], 'sandbox.exe')
    assert.equal(terminals[index].argv[1], '/bin/zsh')
    const session = ctx.backend.createSession(terminals[index], ctx.backend.config)
    const originalSend = session.startSend
    await session.initialize()
    assert.equal(session.startSend, originalSend)
    assert.ok(session.requests[0].text.includes(index ? 'second' : 'first'))
    assert.ok(!session.requests[0].text.includes(index ? 'first' : 'second'))
    assert.match(session.requests[0].text, /133;D/)
    assert.equal(session.requests[0].submit, true)
  }
})
