import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { assertBashPolicy, assertWindowsWorkdir, bashProbeArgv, bashRuntimeArgv,
  isWindowsBash, runtimeEnvironment, validateBashProbe } from './bash-runtime.mjs'

export class SelectedWindowsExecutor extends SandboxPwshExecutor {
  static inject = [...SandboxPwshExecutor.inject, 'shellSelection']

  constructor(ctx, config) {
    if (ctx.shellSelection.selected.id === 'default') {
      throw new Error('dsh-shell: default requires dsh-shell/assembly, not a SelectedExecutor; update the profile and restart DSH')
    }
    super(ctx, config)
    this.selection = ctx.shellSelection.selected
  }

  get pwshPath() {
    return this.selection?.path ?? super.pwshPath
  }

  argv(spec) {
    if (!isWindowsBash(this.selection)) return super.argv(spec)
    return spec.bashProbe ? bashProbeArgv(this.selection)
      : bashRuntimeArgv(this.selection, spec.workdir, spec.command)
  }

  spawnSpec(spec, stdoutMaxBytes, signal, argv) {
    const envelope = super.spawnSpec(spec, stdoutMaxBytes, signal, argv)
    if (!isWindowsBash(this.selection)) return envelope
    // Forward the final environment after DSH has applied defaults and dshEnv.
    return { ...envelope,
      env: runtimeEnvironment(this.selection, { TERM: 'dumb', ...envelope.env },
        this.selection.id === 'wsl' ? scrubbedParentEnv() : {}) }
  }

  async verifyBash(spec) {
    assertBashPolicy(this.selection, spec.sandboxPolicy)
    assertWindowsWorkdir(spec.workdir)
    if (this.bashCapabilities) return this.bashCapabilities
    const probe = await super.execute({ ...spec, bashProbe: true, command: '', stdin: undefined,
      timeoutMs: Math.min(spec.timeoutMs, 10000), onExpiry: 'kill', stdoutMaxBytes: 4096 })
    const capabilities = validateBashProbe(this.selection, await probe.result())
    this.bashCapabilities = capabilities // Failures and interrupted probes are never cached.
    return capabilities
  }

  async execute(spec) {
    if (!isWindowsBash(this.selection)) return super.execute(spec)
    await this.verifyBash(spec)
    spec.signal?.throwIfAborted()
    return super.execute(spec)
  }
}

export default SelectedWindowsExecutor
