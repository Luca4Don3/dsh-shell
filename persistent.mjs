import z from '@deepseek-ai/schemastery'
import * as BashPersistent from '@deepseek-ai/dsh-tool-bash-persistent'
import * as PwshPersistent from '@deepseek-ai/dsh-tool-pwsh-persistent'
import { posixDialect, posixSyntaxGuidance } from './posix-runtime.mjs'
import { withToolRegistration } from './tool-context.mjs'
import { withPersistentTransport } from './persistent-runtime.mjs'

export const name = 'persistent-selected-shell'
export const inject = ['tools', 'terminals', 'shellSelection']
export const Config = z.object({
  backendType: z.string().default('shell'),
  timeoutMs: z.number().default(300000),
  maxOutputChars: z.number().default(16000),
  description: z.string().required(false),
})

function defaultDescription(selection) {
  if (selection.dialect === 'pwsh') return [
    'Run commands in a persistent PowerShell shell.',
    '* The "command" parameter does NOT need to be XML-escaped.',
    "* You don't have access to the internet via this tool.",
    '* State is persistent across command calls and discussions with the user.',
    '* Use native Windows paths (C:\\...) and $env:NAME variables; this is PowerShell, not bash.',
    '* Please avoid commands that may produce a very large amount of output.',
    "* Please run long lived commands in the background, e.g. 'Start-Job' or start a server with Start-Process.",
  ].join('\n')

  const shell = selection.id === 'wsl' ? 'bash shell inside WSL'
    : selection.runtime ? `bash shell in ${selection.runtime}` : `${selection.shell ?? 'bash'} shell`
  return [
    `Run commands in a persistent ${shell}. The tool is named bash for DSH compatibility.`,
    `* ${posixSyntaxGuidance(selection.shell ?? 'bash')}`,
    '* The "command" parameter does NOT need to be XML-escaped.',
    '* Network access depends on the task environment. Prefer configured mirrors/proxies when they are available.',
    '* State is persistent across command calls and discussions with the user.',
    "* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.",
    '* Please avoid commands that may produce a very large amount of output.',
    "* Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.",
  ].join('\n')
}

export function apply(ctx, config) {
  const selection = ctx.shellSelection.selected
  const description = config.description || defaultDescription(selection)
  const plugin = selection.dialect === 'pwsh' ? PwshPersistent : BashPersistent
  const adapted = selection.dialect === 'pwsh' || selection.id === 'auto' ? ctx
    : withToolRegistration(ctx, definition => ({ ...definition,
      parameters: { ...definition.parameters, properties: { ...definition.parameters.properties,
        command: { ...definition.parameters.properties.command,
          description: `The ${selection.shell ?? 'bash'} command to run. ${posixSyntaxGuidance(selection.shell ?? 'bash')}` },
      } },
    }))
  const transport = selection.dialect !== 'pwsh' && ['posix', 'fish', 'csh', 'zsh'].includes(posixDialect(selection.shell ?? 'bash'))
    ? withPersistentTransport(adapted, selection.shell) : adapted
  return plugin.apply(transport, { ...config, description })
}
