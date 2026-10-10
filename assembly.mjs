import { Context } from '@deepseek-ai/cordis'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox'
import { Entry, interpolate } from '@deepseek-ai/cordis-plugin-loader'

export const name = 'shell-assembly'
const OfficialExecutor = process.platform === 'win32' ? SandboxPwshExecutor : SandboxBashExecutor
export const inject = [...OfficialExecutor.inject, 'shellSelection', 'loader']
const scopeKeys = ['isolate', 'intercept', 'inject']

// Deliberately no Config: the selected child alone validates the raw executor
// config. Parsing a volatile Config twice would create independent references.
export async function apply(ctx, config) {
  if (ctx.shellSelection.selected.id !== 'default') {
    const { default: SelectedExecutor } = await import('./shell.mjs')
    await ctx.plugin(SelectedExecutor, config)
    return
  }

  const id = process.platform === 'win32' ? 'pwsh-sandbox' : 'bash-sandbox'
  const moduleName = process.platform === 'win32'
    ? '@deepseek-ai/dsh-pwsh-sandbox' : '@deepseek-ai/dsh-bash-sandbox'
  const entries = [...ctx.loader.entries()].filter(entry => entry.options.id === id)
  const entry = entries.length === 1 ? entries[0] : undefined
  const assemblyEntry = ctx.fiber.entry
  const customScope = entry && scopeKeys.some(key => Object.keys(entry.options[key] ?? {}).length)
  if (!entry || entry.options.name !== moduleName || !entry.disabled
    || !assemblyEntry || entry.parent !== assemblyEntry.parent
    || customScope || scopeKeys.some(key => Object.keys(assemblyEntry.options[key] ?? {}).length)) {
    throw new Error(customScope
      ? `dsh-shell: default cannot preserve the custom executor scope of ${id}; remove its isolate/intercept/inject and restart DSH`
      : `dsh-shell: default requires exactly one disabled official ${id} row beside the assembly in an unmodified scope; check the profile composition and restart DSH`)
  }
  // Preserve the original official row, including deployment overrides and its
  // expression context. In particular, Windows must not inherit the selected
  // executor's 60s timeout: official PowerShell defaults to 120s.
  //
  // A disabled entry never runs Loader._patchContext(), so its own context still
  // points at the loader root. Rebuild the authoritative expression scope from
  // the row's actual parent without mutating any entry: after _patchContext the
  // parent chain and inherited isolate/intercept maps are exactly this.
  const expressionContext = entry.parent.ctx.extend({ [Entry.key]: entry })
  await ctx.plugin(OfficialExecutor, interpolate(expressionContext, entry.options.config ?? {}))
}
