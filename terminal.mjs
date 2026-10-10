import { apply as applyTerminal, BashTerminalBackend, Config as TerminalConfig } from '@deepseek-ai/dsh-terminal-bash'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { assertBashPolicy, bashRuntimeArgv, isWindowsBash, runtimeEnvironment } from './bash-runtime.mjs'
import { inheritPosixEnvironment, initializePosixSession, posixShellArgs } from './posix-runtime.mjs'

export const name = 'terminal-selected-shell'
export const inject = ['terminals', 'sandboxPolicy', 'sessionProjections', 'subprocess', 'shellSelection', 'shell']
export const Config = TerminalConfig

class SelectedTerminalBackend extends BashTerminalBackend {
  async spawn(spec) {
    if (isWindowsBash(this.selection)) {
      const policy = this.ctx.sandboxPolicy.resolve({ session: spec.owner.session })
      assertBashPolicy(this.selection, policy)
      const workdir = spec.cwd ?? policy.workspaceRoot
      if (typeof this.ctx.shell.verifyBash !== 'function') {
        throw new Error('dsh-shell: the selected Windows executor is required for Bash terminals')
      }
      await this.ctx.shell.verifyBash(this.ctx.shell.resolve({ command: '', workdir,
        sandboxPolicy: policy, signal: spec.signal }))
      spec.signal?.throwIfAborted()
      const [shellPath, ...shellArgs] = bashRuntimeArgv(this.selection, workdir, undefined, true)
      const backend = new BashTerminalBackend(this.ctx, { ...this.config, shellPath, shellArgs },
        envelope => this.ctx.subprocess.spawnTerminal({ ...envelope,
          env: runtimeEnvironment(this.selection, { ...envelope.env,
            DSH_SHELL_INJECTED_PROMPT: envelope.env.PROMPT_COMMAND ?? '' },
          this.selection.id === 'wsl' ? scrubbedParentEnv() : {}) }))
      return backend.spawn({ ...spec, cwd: workdir })
    }
    return super.spawn(spec)
  }
}

export function apply(ctx, config) {
  const selection = ctx.shellSelection.selected
  if (selection.id === 'default') {
    // An authored raw config decides its own dialect; only an absent row falls
    // back to the native platform default. ctx.fiber._config is that raw config
    // when this plugin runs from a preset row; a direct apply passes it resolved.
    const raw = ctx.fiber?._config
    const explicit = typeof raw === 'object' && raw !== null && 'shellDialect' in raw
    return applyTerminal(ctx, explicit ? config : { ...config, shellDialect: selection.dialect })
  }
  if (config.shellPath || config.shellArgs?.length || (config.shellDialect && config.shellDialect !== 'bash')) {
    throw new Error('terminal-selected-shell: configure shell in the dsh-shell plugin, not the terminal backend')
  }
  let resolved
  let spawnTerminal
  const startupWorkdirs = new WeakMap()
  const selectedPosix = selection.id !== 'auto' && !isWindowsBash(selection) && selection.dialect !== 'pwsh'
  const initializePosix = selectedPosix || !!selection.environmentShell
  if (isWindowsBash(selection)) {
    resolved = TerminalConfig({ ...config, shellDialect: 'bash', shellPath: selection.path })
  } else if (selection.dialect === 'pwsh') {
    resolved = TerminalConfig({ ...config, shellDialect: 'pwsh', ...(selection.path ? { shellPath: selection.path } : {}) })
  } else if (selectedPosix) {
    resolved = TerminalConfig({ ...config, shellDialect: 'bash', shellPath: selection.path,
      shellArgs: posixShellArgs(selection) })
  } else {
    resolved = TerminalConfig({ ...config, shellDialect: 'bash', shellPath: selection.path })
  }
  if (initializePosix) spawnTerminal = async spec => {
    const terminal = await ctx.subprocess.spawnTerminal({ ...spec,
      env: ['bash', 'sh'].includes(selection.shell) ? { ...spec.env,
        DSH_SHELL_INJECTED_PROMPT: spec.env.PROMPT_COMMAND ?? '' } : spec.env })
    startupWorkdirs.set(terminal, spec.cwd)
    return terminal
  }
  // Let DSH resolve dialect defaults and validate bounds before adapting its backend.
  const terminals = new Proxy(ctx.terminals, { get(target, key) {
    if (key === 'registerBackend') return original => {
      const [shellPath, ...shellArgs] = inheritPosixEnvironment([original.config.shellPath, ...original.config.shellArgs], selection)
      const backend = new SelectedTerminalBackend(ctx, shellPath === original.config.shellPath && shellArgs.every((arg, index) => arg === original.config.shellArgs[index])
        ? original.config : { ...original.config, shellPath, shellArgs }, spawnTerminal)
      backend.selection = selection
      if (initializePosix) backend.createSession = (terminal, config) =>
        initializePosixSession(original.createSession(terminal, config), selection, startupWorkdirs.get(terminal))
      return target.registerBackend(backend)
    }
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  return applyTerminal(new Proxy(ctx, { get(target, key) {
    if (key === 'terminals') return terminals
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  } }), resolved)
}
