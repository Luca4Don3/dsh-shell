import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accessSync, constants, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { adaptPersistentCommand, withPersistentTransport } from '../persistent-runtime.mjs'
import { posixPromptSetup, posixShellArgs, quotePosixArgument } from '../posix-runtime.mjs'

// DSH 0.2.0-rc.1's actual transport contract, including ANSI-C quoting.
function upstreamFrame(command, nonce) {
  const quote = value => `$'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\r', '\\r').replaceAll('\n', '\\n')}'`
  return `printf '%s\\n' ${quote(`__DSH_PERSISTENT_BASH_START_${nonce}__`)}; eval -- ${quote(command)}; __dsh_persistent_bash_status=$?; printf '%s%s\\n' ${quote(`__DSH_PERSISTENT_BASH_END_${nonce}:`)} "$__dsh_persistent_bash_status"`
}

test('persistent transport retains lifecycle receivers, signals and empty readiness polls', () => {
  const calls = []
  const terminals = {
    startSend(...args) { assert.equal(this, terminals); calls.push(args); return handle },
    kill() { assert.equal(this, terminals); return 'killed' },
  }
  const handle = { done: Promise.resolve(), cancel() {} }
  const ctx = { terminals, effect() { assert.equal(this, ctx) } }
  const adapted = withPersistentTransport(ctx, 'dash')
  const signal = new AbortController().signal
  for (const text of ['stty -echo', '', upstreamFrame('false', 'abcd')]) {
    const request = { text, submit: !!text, signal }
    assert.equal(adapted.terminals.startSend('owner', 'id', request), handle)
    assert.equal(calls.at(-1)[2].signal, signal)
    assert.equal(calls.at(-1)[2].submit, request.submit)
    assert.equal(request.text, text)
  }
  assert.equal(calls[0][2].text, 'stty -echo')
  assert.equal(calls[1][2].text, '')
  assert.equal(adapted.terminals.kill(), 'killed')
  adapted.effect()
  assert.throws(() => adaptPersistentCommand('unknown future frame', 'dash'), /unsupported DSH/)
  assert.throws(() => adaptPersistentCommand(upstreamFrame('pwd', 'abcd').replace('END_abcd', 'END_dcba'), 'dash'), /invalid DSH/)
})

for (const shell of ['bash', 'zsh', 'sh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'csh', 'tcsh']) {
  const path = process.platform === 'win32' ? undefined : ['/bin', '/usr/bin', '/opt/homebrew/bin', '/usr/local/bin']
    .map(dir => `${dir}/${shell}`).find(path => { try { accessSync(path, constants.X_OK); return true } catch { return false } })
  test(`${shell} executes persistent frames and retains state, cwd, quoting and exit status`, { skip: !path }, () => {
    const directory = fileURLToPath(new URL('../.temp/', import.meta.url))
    mkdirSync(directory, { recursive: true })
    const home = mkdtempSync(`${directory}persistent-frame-`)
    const workdir = `${home}/O'Reilly ! workspace`
    mkdirSync(workdir)
    const csh = shell === 'csh' || shell === 'tcsh'
    const set = csh ? 'set REVIEW_STATE=alive' : shell === 'fish' ? 'set -g REVIEW_STATE alive' : 'REVIEW_STATE=alive'
    const value = "quoted ' value\\backslash !bang\nsecond line"
    const commands = [
      `${set}\ncd ${quotePosixArgument(workdir, shell)}`,
      'printf "state:%s\\n" "$REVIEW_STATE"\npwd\nfalse',
      `printf '%s\\n' ${quotePosixArgument(value, shell)}`,
    ].map((command, index) => adaptPersistentCommand(upstreamFrame(command, `abcd-${index}`), shell))
    const spec = { argv: [path, ...posixShellArgs({ shell, path })], cwd: home,
      env: { HOME: home, ZDOTDIR: home, PATH: '/usr/bin:/bin', TERM: 'dumb' },
      input: [posixPromptSetup({ shell }, home), 'stty -echo', ...commands, 'exit'].join('\n') + '\n' }
    const run = spawnSync('python3', [fileURLToPath(new URL('./pty-fixture.py', import.meta.url))],
      { input: JSON.stringify(spec), encoding: 'utf8', timeout: 10000 })
    assert.equal(run.error, undefined)
    assert.equal(run.status, 0, run.stderr)
    const result = JSON.parse(run.stdout), output = result.stdout.replaceAll('\r', '')
    assert.equal(result.timedOut, false, output)
    assert.ok(output.includes('state:alive\n'), output)
    assert.ok(output.includes(`${workdir}\n`), output)
    assert.ok(output.includes(value + '\n'), output)
    for (const [index, status] of [[0, 0], [1, 1], [2, 0]]) {
      assert.ok(output.includes(`__DSH_PERSISTENT_BASH_END_abcd-${index}:${status}\n`), output)
      const start = `__DSH_PERSISTENT_BASH_START_abcd-${index}__\n`
      const body = output.slice(output.lastIndexOf(start) + start.length,
        output.lastIndexOf(`__DSH_PERSISTENT_BASH_END_abcd-${index}:`))
      assert.equal(body, ['', `state:alive\n${workdir}\n`, `${value}\n`][index], output)
    }
  })
  test(`${shell} transports literal CR and CRLF without changing bytes or losing completion`, { skip: !path }, () => {
    const directory = fileURLToPath(new URL('../.temp/', import.meta.url))
    mkdirSync(directory, { recursive: true })
    const home = mkdtempSync(`${directory}persistent-cr-`)
    const value = "\rquoted ' value\\backslash !bang\r\nsecond line\r"
    const command = `printf '%s' ${quotePosixArgument(value, shell)} | od -An -v -tx1 | tr -d ' \\n'; printf '\\n'`
    const adapted = adaptPersistentCommand(upstreamFrame(command, 'abcd'), shell)
    assert.equal(adapted.includes('\r'), false)
    const spec = { argv: [path, ...posixShellArgs({ shell, path })], cwd: home,
      env: { HOME: home, ZDOTDIR: home, PATH: '/usr/bin:/bin', TERM: 'dumb' },
      input: [posixPromptSetup({ shell }, home), 'stty -echo', adapted, 'exit'].join('\n') + '\n' }
    const run = spawnSync('python3', [fileURLToPath(new URL('./pty-fixture.py', import.meta.url))],
      { input: JSON.stringify(spec), encoding: 'utf8', timeout: 10000 })
    assert.equal(run.error, undefined)
    assert.equal(run.status, 0, run.stderr)
    const result = JSON.parse(run.stdout), output = result.stdout.replaceAll('\r', '')
    assert.equal(result.timedOut, false, output)
    const start = '__DSH_PERSISTENT_BASH_START_abcd__\n', end = '__DSH_PERSISTENT_BASH_END_abcd:'
    assert.ok(output.includes(`${end}0\n`), output)
    assert.equal(output.slice(output.lastIndexOf(start) + start.length, output.lastIndexOf(end)),
      `${Buffer.from(value).toString('hex')}\n`, output)
  })
  if (shell === 'csh' || shell === 'tcsh') test(`${shell} completes failed expansions and continues the persistent session`, { skip: !path }, () => {
    const directory = fileURLToPath(new URL('../.temp/', import.meta.url))
    mkdirSync(directory, { recursive: true })
    const home = mkdtempSync(`${directory}persistent-error-`)
    writeFileSync(`${home}/.cshrc`, 'alias precmd \'printf "user-status:%s\\n" "$status"; false\'\n')
    const commands = [
      'set REVIEW_STATE=alive',
      'echo "$REVIEW_UNDEFINED"',
      'echo *.definitely-missing',
      'printf "state:%s\\n" "$REVIEW_STATE"',
      'false',
      'sh -c "exit 7"',
    ].map((command, index) => adaptPersistentCommand(upstreamFrame(command, `abcd-${index}`), shell))
    const spec = { argv: [path, ...posixShellArgs({ shell, path })], cwd: home,
      env: { HOME: home, PATH: '/usr/bin:/bin', TERM: 'dumb' },
      input: [posixPromptSetup({ shell }, home), 'stty -echo', ...commands, 'exit'].join('\n') + '\n' }
    const run = spawnSync('python3', [fileURLToPath(new URL('./pty-fixture.py', import.meta.url))],
      { input: JSON.stringify(spec), encoding: 'utf8', timeout: 10000 })
    assert.equal(run.error, undefined)
    assert.equal(run.status, 0, run.stderr)
    const result = JSON.parse(run.stdout), output = result.stdout.replaceAll('\r', '')
    assert.equal(result.timedOut, false, output)
    assert.equal(result.status, 0, output)
    assert.match(output, /Undefined variable/)
    assert.match(output, /No match/)
    assert.ok(output.includes('state:alive\n'), output)
    assert.ok(output.includes('user-status:1\n'), output)
    assert.ok(output.includes('\x1b]133;D;1\x07dsh> '), output)
    for (const [index, status] of [[0, 0], [1, 1], [2, 1], [3, 0], [4, 1], [5, 7]]) {
      assert.ok(output.includes(`__DSH_PERSISTENT_BASH_END_abcd-${index}:${status}\n`), output)
      assert.equal([...output.matchAll(new RegExp(`__DSH_PERSISTENT_BASH_END_abcd-${index}:\\d+\\n`, 'g'))].length, 1, output)
    }
  })
}
