import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { detectInstalledShells, resolveSelection } from './selection.mjs'

export const name = 'dsh-shell'
export const inject = ['systemPrompt']
const detectionWarnings = []
const installedShells = detectInstalledShells(process.platform, process.env, { report: message => detectionWarnings.push(message) })
const wsl = installedShells.find(item => item.id === 'wsl')
const wslDistributions = wsl?.distributionDetails ?? []
function distributionLabel(item) {
  const unverified = item.version && ![1, 2].includes(item.version) ? ' (unverified)' : ''
  return `${item.name} · WSL ${item.version ?? '?'}${unverified}${item.isDefault ? ' ★' : ''}${item.state ? ` · ${item.state}` : ''}`
}

export const Config = z.object({
  shell: z.union(['auto', ...installedShells.map(item => z.const(item.id).description(item.label ?? item.id)),
    ...[...new Set(installedShells.map(item => item.shell).filter(Boolean))]
      .map(shell => z.const(shell).description(`${shell} · default installation (legacy)`)),
  ]).default('auto').volatile(),
  shellPath: z.string().required(false).volatile(),
  wslDistribution: (wslDistributions.length
    ? z.union(wslDistributions.map(item => z.const(item.name).description(distributionLabel(item))))
    : z.string()).required(false).volatile(),
})

function current(value) {
  return typeof value?.get === 'function' ? value.get() : value
}

class ShellSelection extends Service {
  constructor(ctx, config) {
    super(ctx, 'shellSelection')
    this.selected = resolveSelection({
      shell: current(config.shell),
      shellPath: current(config.shellPath),
      wslDistribution: current(config.wslDistribution),
    }, process.platform, process.env, installedShells, message => ctx.logger.warn(message))
    this.available = installedShells
  }
}

export function apply(ctx, config) {
  const selection = new ShellSelection(ctx, config)
  for (const message of detectionWarnings) ctx.logger.warn(message)
  ctx.logger.info(`available agent shells: ${selection.available.map(item => item.id).join(', ')}`)
  const { id, dialect } = selection.selected
  const guidance = id === 'wsl'
    ? 'The one-shot tool is named `pwsh` by DSH, but it runs Bash inside the selected WSL distribution. Write Bash commands and Linux paths inside command. The workdir parameter must use a Windows host path; it is converted inside the distribution. The persistent tool is named `bash`.'
    : `The model-facing shell tool runs ${id === 'auto' ? 'the DSH default shell' : selection.selected.label ?? id} (${dialect} syntax).`
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'shell:selected-runtime',
    order: 90,
    text: `${guidance} The minimal preset also provides a persistent shell tool whose state survives calls; the one-shot tool starts a fresh shell for each call.`,
  }))
}
