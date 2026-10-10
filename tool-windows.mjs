import * as PwshTool from '@deepseek-ai/dsh-tool-pwsh'
import { isWindowsBash } from './bash-runtime.mjs'
import { withToolRegistration } from './tool-context.mjs'

export const name = 'tool-selected-windows-shell'
export const inject = [...PwshTool.inject, 'shellSelection']
export const Config = PwshTool.Config

export function adaptBashTool(definition, selection) {
  const runtime = selection.id === 'wsl' ? `Bash in WSL (${selection.distribution})` : `Bash in ${selection.runtime}`
  return { ...definition,
    // This branch runs only when the selection executes Bash on the Windows host
    // (Git Bash, MSYS2, Cygwin or WSL), so the registered name follows that shell
    // instead of the PowerShell tool it was registered under.
    name: 'bash',
    description: `Execute a command using ${runtime}. Write Bash syntax and POSIX paths inside command; use $NAME for environment variables. Each call starts a fresh shell. workdir is an absolute Windows host path, not a Linux directory. Login profiles are loaded in the interactive shell; the user profile controls whether to source .bashrc, with a direct .bashrc fallback only when no user profile exists. Long output is truncated; spill paths refer to the Windows host. Background jobs and timeout handling follow DSH. ${selection.id === 'wsl' ? 'WSL requires danger-full-access; restricted sandbox modes fail explicitly.' : 'DSH sandbox restrictions still apply; do not retry a denied command another way.'}`,
    parameters: { ...definition.parameters, properties: {
      ...definition.parameters.properties,
      command: { ...definition.parameters.properties.command, description: `The Bash command to execute in ${runtime}.` },
      workdir: { ...definition.parameters.properties.workdir,
        description: 'Windows host working directory (C:\\... or \\\\server\\share); defaults to the session workspace. Relative paths resolve against that workspace. Use Linux/POSIX paths inside command.' },
    } },
  }
}

export function apply(ctx, config) {
  const selection = ctx.shellSelection.selected
  if (!isWindowsBash(selection)) return PwshTool.apply(ctx, config)
  return PwshTool.apply(withToolRegistration(ctx, definition => adaptBashTool(definition, selection)), config)
}
