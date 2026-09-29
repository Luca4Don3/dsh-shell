import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'

export function quoteForBash(value) {
  if (value.includes('\0')) throw new TypeError('shell command cannot contain NUL')
  return `'${value.replaceAll("'", "'\\''")}'`
}

export class SelectedPosixExecutor extends SandboxBashExecutor {
  static inject = [...SandboxBashExecutor.inject, 'shellSelection']

  constructor(ctx, config) {
    super(ctx, config)
    this.selection = ctx.shellSelection.selected
  }

  async execute(spec) {
    const { shell, path } = this.selection
    if (shell === 'bash' && this.selection.id === 'auto') return super.execute(spec)
    return super.execute({ ...spec, command: `exec ${quoteForBash(path)} -lic ${quoteForBash(spec.command)}` })
  }
}

export default SelectedPosixExecutor
