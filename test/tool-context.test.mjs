import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withToolRegistration } from '../tool-context.mjs'

test('registration adapts only the definition and preserves options, receiver and disposer', () => {
  const calls = []
  const dispose = () => {}
  const tools = {
    register(...args) { assert.equal(this, tools); calls.push(args); return dispose },
    lookup() { assert.equal(this, tools); return this },
  }
  const ctx = { tools, get() { assert.equal(this, ctx); return this } }
  const definition = Object.freeze({ name: 'bash', execute() {} })
  const adapted = Object.freeze({ ...definition, name: 'zsh' })
  const when = () => false
  const options = Object.freeze({ when })
  const scoped = withToolRegistration(ctx, value => {
    assert.equal(value, definition)
    return adapted
  })
  assert.equal(scoped.tools.register(definition, options), dispose)
  assert.deepEqual(calls, [[adapted, options]])
  assert.equal(calls[0][1], options)
  assert.equal(calls[0][1].when, when)
  assert.equal(scoped.tools.lookup(), tools)
  assert.equal(scoped.get(), ctx)
  assert.equal(ctx.tools, tools)
  assert.equal(definition.name, 'bash')
})

test('legacy single-argument registration retains its exact call shape', () => {
  const calls = []
  const definition = { name: 'bash' }
  const ctx = { tools: { register(...args) { calls.push(args) } } }
  withToolRegistration(ctx, value => value).tools.register(definition)
  assert.deepEqual(calls, [[definition]])
})

test('registration forwards explicit undefined and future trailing arguments unchanged', () => {
  const calls = []
  const definition = { name: 'bash' }
  const marker = Symbol('host-extension')
  const ctx = { tools: { register(...args) { calls.push(args) } } }
  withToolRegistration(ctx, value => value).tools.register(definition, undefined, marker)
  assert.deepEqual(calls, [[definition, undefined, marker]])
})

test('upstream registration errors propagate without a fallback registration', () => {
  const failure = new Error('host registration failed')
  let calls = 0
  const ctx = { tools: { register() { calls += 1; throw failure } } }
  assert.throws(() => withToolRegistration(ctx, value => value).tools.register({ name: 'bash' }),
    error => error === failure)
  assert.equal(calls, 1)
})
