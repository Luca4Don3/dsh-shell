import assert from 'node:assert/strict'
import { test } from 'node:test'
import { adoptJobKinds } from '../job-kinds.mjs'

// Minimal stand-in for the host jobs registry: it records the spec each start
// call actually receives, so calls observe argument copying and `this` binding.
function mockJobs() {
  return {
    started: [],
    start(spec) {
      this.started.push(spec)
      return { id: `${spec.kind}-${this.started.length}` }
    },
  }
}

test('bash jobs take the selected shell kind while other kinds pass through', () => {
  const jobs = mockJobs()
  const release = adoptJobKinds(jobs, 'zsh')
  const bashSpec = { kind: 'bash', label: 'echo hi' }
  jobs.start(bashSpec)
  jobs.start({ kind: 'web', label: 'fetch' })
  assert.equal(jobs.started[0].kind, 'zsh')
  assert.equal(jobs.started[0].label, 'echo hi')
  assert.equal(jobs.started[1].kind, 'web')
  assert.equal(bashSpec.kind, 'bash', 'the caller\'s spec object stays untouched')
  release()
})

test('adoption is reference counted and restores the original method', () => {
  const jobs = mockJobs()
  const before = jobs.start
  const releaseFirst = adoptJobKinds(jobs, 'zsh')
  const releaseSecond = adoptJobKinds(jobs, 'zsh')
  jobs.start({ kind: 'bash' })
  assert.equal(jobs.started.at(-1).kind, 'zsh')
  releaseFirst()
  jobs.start({ kind: 'bash' })
  assert.equal(jobs.started.at(-1).kind, 'zsh', 'still adopted after one release')
  releaseSecond()
  assert.equal(jobs.start, before, 'the original method returns with the last release')
  jobs.start({ kind: 'bash' })
  assert.equal(jobs.started.at(-1).kind, 'bash')
})

test('a registry without a start method is a no-op adoption', () => {
  const jobs = {}
  const release = adoptJobKinds(jobs, 'zsh')
  assert.equal(jobs.start, undefined)
  release()
})
