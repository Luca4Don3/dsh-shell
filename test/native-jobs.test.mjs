import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { useOfficialDependencies } from './official-helpers.mjs'

// Real Registry + official one-shot tool integration. The subprocess spawn is a
// capability seam that records envelopes; the executor, jobs registry, tool and
// tool lifecycle are the genuine official implementations.
const official = useOfficialDependencies()

const unavailable = official.skip
if (unavailable) {
  test('native job contract integration requires the official runtime', { skip: unavailable }, () => {})
} else {
  const { Context } = await import('@deepseek-ai/cordis')
  const { SandboxBashExecutor } = await import('@deepseek-ai/dsh-bash-sandbox')
  const { default: JobsLocal } = await import('@deepseek-ai/dsh-jobs-local')
  const { default: Policy } = await import('@deepseek-ai/dsh-sandbox-policy')
  const { default: Projection } = await import('@deepseek-ai/dsh-session-projection')
  const BashTool = await import('@deepseek-ai/dsh-tool-bash')
  const SelectedPosixTool = await import('../tool-posix.mjs')
  const shellEnvModule = await import('@deepseek-ai/dsh-shell-env')

  const workspaceRoot = '/isolated-jobs-workspace'
  const policy = { mode: 'workspace-write', workspaceRoot }

  function recordingSubprocess(options = {}) {
    const calls = []
    const reader = text => ({ readFrom: (offset = 0) => ({ text: text.slice(offset),
      nextOffset: text.length, lossy: false }) })
    return { calls, spawn(spec) {
      calls.push(spec)
      const text = 'official-result\n'
      // Manual settlement keeps one live process for the kill assertions; the
      // foreground lanes settle immediately, exactly like the recorded envelope.
      let settle
      const done = options.settle === 'manual'
        ? new Promise(resolve => { settle = resolve }) : Promise.resolve({ exitCode: 0, signal: null })
      return { status: 'running', collected: { stdout: reader(text), stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } },
        done, terminate() { if (settle) settle({ exitCode: null, signal: 'SIGTERM' }); this.status = 'killed'; return true },
        kill() { return this.terminate() } }
    } }
  }

  async function fixture(selection, options = {}) {
    const ctx = new Context()
    ctx.logger.exporters.clear()
    const subprocess = recordingSubprocess(options)
    const confined = []
    ctx.provide('subprocess', subprocess)
    ctx.provide('sandbox', { async confine(argv, effective) {
      confined.push({ argv, policy: effective })
      return { argv, enforcement: 'native-jobs-seam', denialSignatures: [], runnerFailureRules: [] }
    } })
    await ctx.plugin(Projection)
    await ctx.plugin(Policy, policy)
    await ctx.plugin(JobsLocal)    // The host composition attaches its own job controller from an unscoped context.
    await ctx.effect(() => ctx.jobs.attachController('native-jobs-controller'))
    await ctx.plugin(shellEnvModule.apply ? shellEnvModule : shellEnvModule.default)
    await ctx.plugin(SandboxBashExecutor, { cwd: workspaceRoot, timeoutMs: 4321, graceMs: 5000 })
    ctx.provide('shellSelection', { selected: selection })
    const definitions = []
    ctx.provide('tools', { register(definition) { definitions.push(definition); return () => {} } })
    ctx.provide('systemPrompt', { section() {}, getSectionOrder() { return 0 } })
    return { ctx, definitions, subprocess, confined, workspaceRoot }
  }

  const executionContext = (signal = new AbortController().signal) =>
    ({ agent: undefined, signal, callId: 'native-jobs-call' })

  const defaultSelection = { id: 'default', dialect: 'bash', shell: 'bash' }

  for (const [label, tool, config] of [
    ['official', BashTool, {}], ['default adapter', SelectedPosixTool, {}],
  ]) {
    test(`native jobs: ${label} registers one bash kind, an official id, ring output and kill semantics`, async t => {
      const foregroundFixture = await fixture(defaultSelection)
      t.after(() => foregroundFixture.ctx.fiber.dispose())
      await foregroundFixture.ctx.plugin(tool, config)
      assert.equal(foregroundFixture.definitions.length, 1)
      assert.equal(foregroundFixture.definitions[0].name, 'bash')
      const jobs = foregroundFixture.ctx.get('jobs')
      const signal = new AbortController().signal

      const foreground = await foregroundFixture.definitions[0].execute(
        { command: "printf 'official-result'", description: "print the official result" }, executionContext(signal))
      assert.equal(foreground.kind, 'foreground')
      assert.equal(foreground.exitCode, 0)
      assert.equal(foreground.timeoutMs, 4321)
      // The official foreground path removes its own settled record.
      assert.deepEqual(jobs.list(), [])

      const harness = await fixture(defaultSelection, { settle: 'manual' })
      t.after(() => harness.ctx.fiber.dispose())
      await harness.ctx.plugin(tool, config)
      const background = await harness.definitions[0].execute(
        { command: "printf 'native-job'", description: "start a native background job", run_in_background: true }, executionContext(signal))
      assert.equal(background.kind, 'background')
      assert.match(background.jobId, /^bash-\d+$/)
      const liveJobs = harness.ctx.get('jobs')
      const view = liveJobs.get(background.jobId)
      assert.equal(view.kind, 'bash')
      assert.equal(view.label, "printf 'native-job'")
      assert.equal(view.owner, undefined)
      assert.equal(view.status, 'running')
      // Let the real spawn reach the recorded envelope before cancelling.
      for (let attempt = 0; attempt < 200 && harness.subprocess.calls.length === 0; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert.equal(harness.subprocess.calls.length, 1)
      liveJobs.kill(background.jobId, undefined, 'native-jobs-test-complete')
      const killed = await liveJobs.wait(background.jobId, 5000)
      assert.equal(killed.status, 'killed')
      assert.match(killed.detail, /native-jobs-test-complete/)
      const read = liveJobs.read(background.jobId)
      assert.ok(read.chunks.some(chunk => chunk.text.includes('official-result')), 'the registry ring keeps the recorded output')
      liveJobs.remove(background.jobId)
      assert.deepEqual(liveJobs.list(), [])
    })
  }

  test('native jobs: default background registration passes the same envelope as the official tool', async t => {
    const officialFixture = await fixture(defaultSelection)
    const defaultFixture = await fixture(defaultSelection)
    t.after(async () => { await Promise.all([officialFixture, defaultFixture].map(async item => item.ctx.fiber.dispose())) })
    await officialFixture.ctx.plugin(BashTool, {})
    await defaultFixture.ctx.plugin(SelectedPosixTool, {})
    await Promise.all([await officialFixture.ctx.inject(['jobs'], () => {}),
      await defaultFixture.ctx.inject(['jobs'], () => {})])
    const signal = new AbortController().signal
    const official = await officialFixture.definitions[0].execute({ command: "printf 'x'", description: "compare envelopes", run_in_background: true }, executionContext(signal))
    const selected = await defaultFixture.definitions[0].execute({ command: "printf 'x'", description: "compare envelopes", run_in_background: true }, executionContext(signal))
    assert.equal(officialFixture.ctx.get('jobs').get(official.jobId).kind,
      defaultFixture.ctx.get('jobs').get(selected.jobId).kind)
    for (const [label, fixture] of [['official', officialFixture], ['default', defaultFixture]]) {
      for (let attempt = 0; attempt < 200 && fixture.subprocess.calls.length < 1; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      const spawn = fixture.subprocess.calls.at(-1)
      assert.ok(spawn, label)
      assert.equal(spawn.argv[0], 'bash', label)
      assert.equal(spawn.argv[2], "printf 'x'", label)
      assert.equal(spawn.cwd, workspaceRoot, label)
      assert.equal(spawn.graceMs, 5000, label)
    }
    assert.deepEqual(officialFixture.confined, defaultFixture.confined)
  })
}
