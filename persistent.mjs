import z from '@deepseek-ai/schemastery'
import * as BashPersistent from '@deepseek-ai/dsh-tool-bash-persistent'
import * as PwshPersistent from '@deepseek-ai/dsh-tool-pwsh-persistent'

export const name = 'persistent-selected-shell'
export const inject = ['tools', 'terminals', 'shellSelection']
export const Config = z.object({
  backendType: z.string().default('shell'),
  timeoutMs: z.number().default(300000),
  maxOutputChars: z.number().default(16000),
  description: z.string().required(false),
})

export function apply(ctx, config) {
  const selection = ctx.shellSelection.selected
  const description = config.description || `Run commands in a persistent ${selection.id === 'auto' ? (process.platform === 'win32' ? 'PowerShell' : 'bash') : selection.id} shell. State persists across calls. Use ${selection.dialect === 'pwsh' ? 'PowerShell' : 'Bash-compatible'} syntax.`
  const plugin = selection.dialect === 'pwsh' ? PwshPersistent : BashPersistent
  plugin.apply(ctx, { ...config, description })
}
