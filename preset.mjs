import AgentPreset from '@deepseek-ai/dsh-agent-preset'

function adaptEntries(entries, tool, adapter) {
  const next = entries.map(entry => {
    if (entry.name === tool) return { ...entry, name: adapter }
    if (entry.group && Array.isArray(entry.config)) {
      const config = adaptEntries(entry.config, tool, adapter)
      if (config !== entry.config) return { ...entry, config }
    }
    return entry
  })
  return next.some((entry, index) => entry !== entries[index]) ? next : entries
}

export function adaptPresetConfig(config, platform = process.platform) {
  const plugins = platform === 'win32'
    ? adaptEntries(config.plugins, '@deepseek-ai/dsh-tool-pwsh', 'dsh-shell/tool-windows')
    : adaptEntries(config.plugins, '@deepseek-ai/dsh-tool-bash', 'dsh-shell/tool-posix')
  return plugins === config.plugins ? config : { ...config, plugins }
}

// Keep the shipped schema, injection and loader EntryGroup marker through inheritance.
// Only the runtime copy changes; authored profile/preset configuration stays intact.
export default class SelectedShellPreset extends AgentPreset {
  constructor(ctx, config) {
    super(ctx, adaptPresetConfig(config))
  }
}
