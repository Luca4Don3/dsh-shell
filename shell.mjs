import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { SelectedWindowsExecutor } from './shell-windows.mjs'
import { quoteBash } from './bash-runtime.mjs'
import { inheritPosixEnvironment, posixShellArgs } from './posix-runtime.mjs'

export function quoteForBash(value) {
  return quoteBash(value)
}

export class SelectedPosixExecutor extends SandboxBashExecutor {
  static inject = [...SandboxBashExecutor.inject, 'shellSelection']

  constructor(ctx, config) {
    super(ctx, config)
    this.selection = ctx.shellSelection.selected
  }

  async execute(spec) {
    const { shell, path } = this.selection
    if (shell === 'bash' && this.selection.id === 'auto' && !this.selection.environmentShell) return super.execute(spec)
    const target = this.selection.id === 'auto' ? ['bash', '-c', spec.command]
      : [path, ...posixShellArgs(this.selection, spec.command, spec.workdir)]
    const argv = inheritPosixEnvironment(target, this.selection, spec.workdir)
    return super.execute({ ...spec, command: `exec ${argv.map(quoteForBash).join(' ')}` })
  }
}

export default process.platform === 'win32' ? SelectedWindowsExecutor : SelectedPosixExecutor
