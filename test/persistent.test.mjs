import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

const mocks = {
  '@deepseek-ai/schemastery': `
    const field = { default() { return this }, required() { return this } }
    export default { object: () => ({}), string: () => field, number: () => field }
  `,
  '@deepseek-ai/dsh-tool-bash-persistent': `
    export const apply = (ctx, config) => {
      ctx.tools.register(globalThis.__persistentDefinition)
      globalThis.__persistentCalls.push({ dialect: 'bash', config, ctx })
    }
  `,
  '@deepseek-ai/dsh-tool-pwsh-persistent': `
    export const apply = (_ctx, config) => globalThis.__persistentCalls.push({ dialect: 'pwsh', config })
  `,
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    const mock = mocks[specifier]
    return mock === undefined ? nextResolve(specifier, context)
      : { url: `data:text/javascript,${encodeURIComponent(mock)}`, shortCircuit: true }
  },
})
globalThis.__persistentCalls = []
globalThis.__persistentDefinition = { name: 'bash', execute() {}, parameters: { properties: { command: { type: 'string' } } } }
const { apply } = await import('../persistent.mjs')
function context(selection, registered = []) {
  return { shellSelection: { selected: selection }, terminals: {}, tools: { register: definition => registered.push(definition) } }
}

test('bash, zsh and WSL retain the shipped persistent-tool guidance', () => {
  for (const selection of [
    { id: 'auto', dialect: 'bash', shell: 'bash' },
    { id: 'zsh', dialect: 'bash', shell: 'zsh' },
    { id: 'wsl', dialect: 'bash' },
  ]) {
    apply(context(selection), {})
    const { dialect, config } = globalThis.__persistentCalls.pop()
    assert.equal(dialect, 'bash')
    for (const phrase of ['XML-escaped', 'mirrors/proxies', 'State is persistent', 'sed -n', 'large amount of output', 'background']) {
      assert.match(config.description, new RegExp(phrase))
    }
    if (selection.id === 'wsl') assert.match(config.description, /inside WSL/)
    if (selection.id === 'zsh') assert.match(config.description, /persistent zsh shell/)
  }
})

test('persistent fish, C shell and POSIX parameters describe their syntax and name while retaining execution', () => {
  for (const shell of ['fish', 'tcsh', 'dash']) {
    const registered = []
    apply(context({ id: shell, shell, dialect: shell === 'tcsh' ? 'csh' : shell === 'dash' ? 'posix' : 'fish' }, registered), {})
    assert.equal(registered[0].execute, globalThis.__persistentDefinition.execute)
    assert.equal(registered[0].name, shell)
    assert.ok(registered[0].parameters.properties.command.description.includes(shell))
    const { config } = globalThis.__persistentCalls.pop()
    assert.match(config.description, new RegExp(`persistent ${shell} shell`))
  }
})

test('the selected zsh persistent tool translates upstream frames before sending them', () => {
  const sent = []
  const ctx = context({ id: 'zsh', shell: 'zsh', dialect: 'bash' })
  const operation = { done: Promise.resolve() }
  ctx.terminals.startSend = (owner, id, request) => { sent.push({ owner, id, request }); return operation }
  apply(ctx, {})
  const adapted = globalThis.__persistentCalls.pop().ctx
  const text = "printf '%s\\n' $'__DSH_PERSISTENT_BASH_START_abcd__'; eval -- $'false'; __dsh_persistent_bash_status=$?; printf '%s%s\\n' $'__DSH_PERSISTENT_BASH_END_abcd:' \"$__dsh_persistent_bash_status\""
  const signal = new AbortController().signal
  assert.equal(adapted.terminals.startSend('owner', 'id', { text, signal, submit: true }), operation)
  assert.equal(sent[0].owner, 'owner')
  assert.equal(sent[0].id, 'id')
  assert.equal(sent[0].request.signal, signal)
  assert.equal(sent[0].request.submit, true)
  assert.match(sent[0].request.text, /__dsh_pending_end=/)
  assert.ok(sent[0].request.text.endsWith("eval $'false'"))
})

test('PowerShell retains native-path guidance and explicit descriptions still win', () => {
  const ctx = { shellSelection: { selected: { id: 'pwsh7', dialect: 'pwsh' } } }
  apply(ctx, {})
  const defaults = globalThis.__persistentCalls.pop()
  assert.equal(defaults.dialect, 'pwsh')
  for (const phrase of ['XML-escaped', 'State is persistent', 'Windows paths', '$env:NAME', 'large amount of output', 'Start-Job']) {
    assert.ok(defaults.config.description.includes(phrase))
  }
  apply(ctx, { description: 'Custom instructions' })
  assert.equal(globalThis.__persistentCalls.pop().config.description, 'Custom instructions')
})
