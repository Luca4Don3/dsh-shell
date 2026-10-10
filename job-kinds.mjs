/**
 * Background-job kinds for the one-shot bash tool.
 *
 * `dsh-tool-bash` starts background jobs with a fixed `kind: "bash"`, and the job
 * list renders `job.kind` verbatim, so jobs started for another shell still list
 * as "bash". Adopting the registry retitles those jobs with the shell that
 * actually runs them.
 */

/** Kind contributed by the one-shot bash tool (see dsh-tool-bash registry.start). */
const BASH_JOB_KIND = 'bash'

const adoptedJobKinds = Symbol('dsh-shell.adoptedJobKinds')

/**
 * Retitle background jobs started by the one-shot bash tool so their kind names
 * the shell that actually runs them. The jobs registry is a shared host service
 * every `ctx.inject(['jobs'])` consumer observes, so patching the instance method
 * covers both the direct tool and its PTC-facing binding. Adoption is reference
 * counted and the original method returns once the last adopter releases it.
 */
export function adoptJobKinds(jobs, shell) {
  const adopted = jobs[adoptedJobKinds]
  if (adopted) {
    adopted.refs += 1
    return () => { if (--adopted.refs === 0) restoreJobKinds(jobs) }
  }
  const original = jobs.start
  if (typeof original !== 'function') return () => {}
  jobs.start = function start(spec) {
    return original.call(this, spec?.kind === BASH_JOB_KIND ? { ...spec, kind: shell } : spec)
  }
  jobs[adoptedJobKinds] = { refs: 1, original }
  return () => { if (--jobs[adoptedJobKinds].refs === 0) restoreJobKinds(jobs) }
}

function restoreJobKinds(jobs) {
  const adopted = jobs[adoptedJobKinds]
  jobs.start = adopted.original
  delete jobs[adoptedJobKinds]
}
