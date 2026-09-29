import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { BashTerminalBackend, Config as TerminalConfig } from '@deepseek-ai/dsh-terminal-bash'
import { quoteForBash } from './shell.mjs'

const startupDirectory = dirname(fileURLToPath(import.meta.url))

export const name = 'terminal-selected-shell'
export const inject = ['terminals', 'sandboxPolicy', 'sessionProjections', 'subprocess', 'shellSelection']
export const Config = TerminalConfig

class SelectedTerminalBackend extends BashTerminalBackend {
  async spawn(spec) {
    if (this.selection.id === 'wsl' && this.ctx.sandboxPolicy.resolve({ session: spec.owner.session }).mode !== 'danger-full-access') {
      throw new Error('dsh-shell: WSL cannot be confined by the DSH Windows sandbox; use danger-full-access explicitly')
    }
    return super.spawn(spec)
  }
}

export function apply(ctx, config) {
  const selection = ctx.shellSelection.selected
  if (config.shellPath || config.shellArgs?.length || (config.shellDialect && config.shellDialect !== 'bash')) {
    throw new Error('terminal-selected-shell: configure shell in the dsh-shell plugin, not the terminal backend')
  }
  let resolved
  let spawnTerminal
  if (selection.id === 'wsl') {
    const prompt = 'printf "\\033]133;D;%s\\007" "$?"; PS1="dsh> "'
    const setup = `export PS1=${quoteForBash('dsh> ')}; export PROMPT_COMMAND=${quoteForBash(prompt)}; exec /bin/bash --noprofile --norc -i`
    resolved = TerminalConfig({ ...config, shellDialect: 'bash', shellPath: selection.path,
      shellArgs: [...(selection.distribution ? ['--distribution', selection.distribution] : []), '--exec', '/bin/bash', '-lc', setup] })
  } else if (selection.dialect === 'pwsh') {
    resolved = TerminalConfig({ ...config, shellDialect: 'pwsh', ...(selection.path ? { shellPath: selection.path } : {}) })
  } else if (selection.shell === 'zsh') {
    resolved = TerminalConfig({ ...config, shellDialect: 'bash', shellPath: selection.path, shellArgs: ['-li'] })
    spawnTerminal = spec => ctx.subprocess.spawnTerminal({ ...spec, env: {
      ...spec.env,
      DSH_ZSH_USER_ZDOTDIR: process.env.ZDOTDIR || process.env.HOME || homedir(),
      ZDOTDIR: startupDirectory,
    } })
  } else {
    resolved = TerminalConfig({ ...config, shellDialect: 'bash', shellPath: selection.path })
  }
  const backend = new SelectedTerminalBackend(ctx, resolved, spawnTerminal)
  backend.selection = selection
  ctx.terminals.registerBackend(backend)
}
