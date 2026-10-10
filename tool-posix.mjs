import * as BashTool from '@deepseek-ai/dsh-tool-bash'
import { adoptJobKinds } from './job-kinds.mjs'
import { posixSyntaxGuidance } from './posix-runtime.mjs'
import { withToolRegistration } from './tool-context.mjs'

export const name = 'tool-selected-posix-shell'
export const inject = [...BashTool.inject, 'shellSelection']
export const Config = BashTool.Config

export function adaptPosixTool(definition, selection) {
  const guidance = posixSyntaxGuidance(selection.shell)
  return { ...definition,
    // The registered name follows the selection, so the UI and the model see the
    // shell that actually runs the command. DSH contributes `bash` for this
    // registration, and nothing else keys off the name.
    name: selection.shell,
    description: `Execute a command in ${selection.shell}. ${guidance} Each call starts a fresh login and interactive shell that reads the user's startup configuration. workdir is a POSIX host path. Long output is truncated; spill paths, background jobs, approvals and timeouts follow DSH. A sandbox denial is a policy boundary; do not retry it another way.`,
    parameters: { ...definition.parameters, properties: { ...definition.parameters.properties,
      command: { ...definition.parameters.properties.command, description: `The ${selection.shell} command to execute. ${guidance}` },
    } },
  }
}

export function apply(ctx, config) {
  const selection = ctx.shellSelection.selected
  if (selection.id === 'auto') return BashTool.apply(ctx, config)
  const fiber = ctx.inject(['jobs'], (jobCtx) => {
    const release = adoptJobKinds(jobCtx.jobs, selection.shell)
    jobCtx.effect(() => () => release())
  })
  const dispose = BashTool.apply(withToolRegistration(ctx, definition => adaptPosixTool(definition, selection)), config)
  return () => {
    if (typeof dispose === 'function') dispose()
    fiber?.dispose?.()
  }
}
