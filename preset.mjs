import AgentPreset from '@deepseek-ai/dsh-agent-preset'

function adaptEntries(entries, tool, adapter, adaptConfig) {
  const next = entries.map(entry => {
    if (entry?.name === tool) return { ...entry, name: adapter,
      ...(adaptConfig ? { config: adaptConfig(entry.config ?? {}) } : {}) }
    if (entry?.group && Array.isArray(entry.config)) {
      const config = adaptEntries(entry.config, tool, adapter, adaptConfig)
      if (config !== entry.config) return { ...entry, config }
    }
    return entry
  })
  return next.some((entry, index) => entry !== entries[index]) ? next : entries
}

// Preserve the v0.2 adapter guidance for untouched shipped minimal descriptions.
// Any different, user-authored description is retained. Native mode never enters
// this path. The exact stock literals are intentionally version-reviewed.
const stockDescriptions = [
  'Run commands in a bash shell\n* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.\n* Network access depends on the task environment. Prefer configured mirrors/proxies when they are available.\n* State is persistent across command calls and discussions with the user.\n* To inspect a particular line range of a file, e.g. lines 10-25, try \'sed -n 10,25p /path/to/the/file\'.\n* Please avoid commands that may produce a very large amount of output.\n* Please run long lived commands in the background, e.g. \'sleep 10 &\' or start a server in the background.',
  'Run commands in a PowerShell shell\n* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.\n* You don\'t have access to the internet via this tool.\n* State is persistent across command calls and discussions with the user.\n* Use native Windows paths (C:\\...) and $env:NAME variables; this is PowerShell, not bash.\n* Please avoid commands that may produce a very large amount of output.\n* Please run long lived commands in the background, e.g. \'Start-Job\' or start a server with Start-Process.',
]

export function adaptPresetConfig(config, platform = process.platform, selection) {
  if (selection?.id === 'default' || !Array.isArray(config?.plugins)) return config
  let plugins = platform === 'win32'
    ? adaptEntries(config.plugins, '@deepseek-ai/dsh-tool-pwsh', 'dsh-shell/tool-windows')
    : adaptEntries(config.plugins, '@deepseek-ai/dsh-tool-bash', 'dsh-shell/tool-posix')
  if (selection) {
    plugins = adaptEntries(plugins, '@deepseek-ai/dsh-terminal-bash', 'dsh-shell/terminal', original => {
      // The shipped Windows dialect is selected by the adapter instead. Keep all
      // other settings, including explicit paths/args (the adapter validates them).
      if (platform !== 'win32' || original.shellDialect !== 'pwsh') return original
      const { shellDialect, ...rest } = original
      return rest
    })
    const persistentConfig = original => {
      if (!stockDescriptions.includes(original.description)) return original
      const { description, ...rest } = original
      return rest
    }
    plugins = adaptEntries(plugins, '@deepseek-ai/dsh-tool-bash-persistent', 'dsh-shell/persistent', persistentConfig)
    plugins = adaptEntries(plugins, '@deepseek-ai/dsh-tool-pwsh-persistent', 'dsh-shell/persistent', persistentConfig)
  }
  return plugins === config.plugins ? config : { ...config, plugins }
}

const shippedEntries = new Set(['preset-standard', 'preset-ptc', 'preset-cordis', 'preset-minimal'])
export function installPresetSelection(ctx) {
  // Official EntryGroup carriers leave child expressions inert until activation.
  // Only transform their runtime copies, never entry.options.config or profile
  // files. Additional/custom carriers are opt-in via the exported preset class.
  ctx.on('internal/config', function (_config, next) {
    const config = next()
    if (this.runtime?.callback !== AgentPreset
      || this.entry?.options.name !== '@deepseek-ai/dsh-agent-preset'
      || !shippedEntries.has(this.entry.options.id)) return config
    return adaptPresetConfig(config, process.platform, ctx.shellSelection.selected)
  }, { global: true })
}

// Preserve the official schema, injection and EntryGroup marker by inheritance.
export default class SelectedShellPreset extends AgentPreset {
  static inject = [...AgentPreset.inject, 'shellSelection']
  constructor(ctx, config) {
    super(ctx, adaptPresetConfig(config, process.platform, ctx.shellSelection.selected))
  }
}
