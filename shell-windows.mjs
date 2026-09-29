import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox'

export class SelectedWindowsExecutor extends SandboxPwshExecutor {
  static inject = [...SandboxPwshExecutor.inject, 'shellSelection']

  constructor(ctx, config) {
    super(ctx, config)
    this.selection = ctx.shellSelection.selected
  }

  get pwshPath() {
    return this.selection?.path ?? super.pwshPath
  }

  argv(spec) {
    if (this.selection.id !== 'wsl') return super.argv(spec)
    return [this.selection.path, ...(this.selection.distribution ? ['--distribution', this.selection.distribution] : []), '--exec', '/bin/bash', '-lc', spec.command]
  }

  async execute(spec) {
    if (this.selection.id === 'wsl' && spec.sandboxPolicy?.mode !== 'danger-full-access') {
      throw new Error('shell-selector: WSL cannot be confined by the DSH Windows sandbox; use danger-full-access explicitly')
    }
    return super.execute(spec)
  }
}

export default SelectedWindowsExecutor
