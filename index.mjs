import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { detectInstalledShells, resolveSelection } from './selection.mjs'

export const name = 'dsh-shell'
export const inject = ['systemPrompt']
const installedShells = detectInstalledShells()
const wslDistributions = installedShells.find(item => item.id === 'wsl')?.distributions ?? []
export const Config = z.object({
  shell: z.union(['auto', ...installedShells.map(item => item.id)]).default('auto'),
  shellPath: z.string().required(false),
  wslDistribution: (wslDistributions.length ? z.union(wslDistributions) : z.string()).required(false),
})

class ShellSelection extends Service {
  constructor(ctx, config) {
    super(ctx, 'shellSelection')
    this.selected = resolveSelection(config, process.platform, process.env, installedShells)
    this.available = installedShells
  }
}

export function apply(ctx, config) {
  const selection = new ShellSelection(ctx, config)
  ctx.logger.info(`available agent shells: ${selection.available.map(item => item.id).join(', ')}`)
  const { id, dialect } = selection.selected
  const guidance = id === 'wsl'
    ? 'The one-shot tool is named `pwsh` by DSH, but it runs Bash inside WSL. Write Bash commands and Linux paths even if that tool description says PowerShell. The persistent tool is named `bash`.'
    : `The model-facing shell tool runs ${id === 'auto' ? 'the DSH default shell' : id} (${dialect} syntax).`
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'shell:selected-runtime',
    order: 90,
    text: `${guidance} The minimal preset also provides a persistent shell tool whose state survives calls; the one-shot tool starts a fresh shell for each call.`,
  }))
}
