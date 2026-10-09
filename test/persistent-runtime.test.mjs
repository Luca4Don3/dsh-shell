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
  assert.throws(() => adaptPersistentCommand(upstreamFrame('x\0y', 'abcd'), 'zsh'), /NUL/)
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
    const ready = status => `\x1b]133;D;${status}\x07dsh> `
    const steps = [
      { input: posixPromptSetup({ shell }, home) + '\n', waitFor: ready(0) },
      { input: adaptPersistentCommand('stty -echo', shell) + '\n', waitFor: ready(0) },
      ...commands.flatMap((command, index) => [
        { input: command + '\n', waitFor: ready([0, 1, 0][index]) },
        { input: ':\n', waitFor: ready(0) },
      ]),
      { input: 'exit\n' },
    ]
    const spec = { argv: [path, ...posixShellArgs({ shell, path })], cwd: home,
      env: { HOME: home, ZDOTDIR: home, PATH: '/usr/bin:/bin', TERM: 'dumb' }, steps }
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
    const ready = status => `\x1b]133;D;${status}\x07dsh> `
    const steps = [
      { input: posixPromptSetup({ shell }, home) + '\n', waitFor: ready(0) },
      { input: adaptPersistentCommand('stty -echo', shell) + '\n', waitFor: ready(0) },
      { input: adapted + '\n', waitFor: ready(0) },
      { input: 'exit\n' },
    ]
    const spec = { argv: [path, ...posixShellArgs({ shell, path })], cwd: home,
      env: { HOME: home, ZDOTDIR: home, PATH: '/usr/bin:/bin', TERM: 'dumb' }, steps }
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

function runFrames(shell, path, commands, startup = '') {
  const directory = fileURLToPath(new URL('../.temp/', import.meta.url))
  mkdirSync(directory, { recursive: true })
  const home = mkdtempSync(`${directory}persistent-recovery-`)
  if (startup) writeFileSync(`${home}/.zshrc`, startup)
  const ready = status => `\x1b]133;D;${status}\x07dsh> `
  const steps = [
    { input: posixPromptSetup({ shell }, home) + '\n', waitFor: ready(0) },
    { input: adaptPersistentCommand('stty -echo', shell) + '\n', waitFor: ready(0) },
    ...commands.flatMap(([command, status], index) => [
      { input: adaptPersistentCommand(upstreamFrame(command, `dcba-${index}`), shell) + '\n',
        waitFor: status === null ? '\x07dsh> ' : ready(status) },
      { input: ':\n', waitFor: ready(0) },
    ]),
    { input: 'exit\n' },
  ]
  const spec = { argv: [path, ...posixShellArgs({ shell, path })], cwd: home,
    env: { HOME: home, ZDOTDIR: home, PATH: '/usr/bin:/bin', TERM: 'dumb' }, steps }
  const run = spawnSync('python3', [fileURLToPath(new URL('./pty-fixture.py', import.meta.url))],
    { input: JSON.stringify(spec), encoding: 'utf8', timeout: 10000 })
  assert.equal(run.error, undefined)
  assert.equal(run.status, 0, run.stderr)
  const result = JSON.parse(run.stdout), output = result.stdout.replaceAll('\r', '')
  assert.equal(result.timedOut, false, output)
  assert.equal(result.status, 0, output)
  const bodies = commands.map(([, status], index) => {
    const start = `__DSH_PERSISTENT_BASH_START_dcba-${index}__\n`
    const ends = [...output.matchAll(new RegExp(`__DSH_PERSISTENT_BASH_END_dcba-${index}:(\\d+)\\n`, 'g'))]
    assert.equal(ends.length, 1, output)
    if (status === null) assert.notEqual(Number(ends[0][1]), 0, output)
    else assert.equal(Number(ends[0][1]), status, output)
    const end = ends[0][0]
    assert.ok(output.includes(start), output)
    return output.slice(output.lastIndexOf(start) + start.length, output.indexOf(end))
  })
  return { bodies, output }
}

for (const shell of ['zsh', 'sh', 'dash', 'ksh', 'mksh', 'ash', 'csh', 'tcsh']) {
  const path = process.platform === 'win32' ? undefined : ['/bin', '/usr/bin', '/opt/homebrew/bin', '/usr/local/bin']
    .map(dir => `${dir}/${shell}`).find(path => { try { accessSync(path, constants.X_OK); return true } catch { return false } })
  test(`${shell} transports long Unicode commands without changing terminal mode or bytes`, { skip: !path }, () => {
    const value = 'x'.repeat(8192) + "'\\!汉字😀\r\n" + '\r'.repeat(64) + "'".repeat(128) + 'trailing\r'
    const csh = ['csh', 'tcsh'].includes(shell)
    const set = csh ? 'set REVIEW_LONG=' : 'REVIEW_LONG='
    const { bodies } = runFrames(shell, path, [
      [set + quotePosixArgument(value, shell), 0],
      [`printf '%s' ${csh ? '$REVIEW_LONG:q' : '"$REVIEW_LONG"'} | od -An -v -tx1 | tr -d ' \\n'; printf '\\n'; stty -a`, 0],
      ['printf "after-long-command\\n"', 0],
    ])
    assert.equal(bodies[0], '')
    assert.ok(bodies[1].startsWith(Buffer.from(value).toString('hex') + '\n'), bodies[1])
    assert.match(bodies[1], /(?:^|\s)icanon(?:\s|;|$)/)
    assert.equal(bodies[2], 'after-long-command\n')
  })
  if (!['csh', 'tcsh', 'sh'].includes(shell)) test(`${shell} reports eval errors once and keeps the session alive`, { skip: !path }, () => {
    const { bodies } = runFrames(shell, path, [
      ['REVIEW_STATE=alive', 0],
      ['if', null],
      ['echo "${REVIEW_UNDEFINED?missing}"', null],
      ['printf "state:%s\\n" "$REVIEW_STATE"', 0],
      ['false', 1],
      ['sh -c "exit 7"', 7],
      ['printf "after-errors\\n"', 0],
    ])
    assert.match(bodies[1], /[Ss]yntax|parse error/)
    assert.match(bodies[2], /missing/)
    assert.equal(bodies[3], 'state:alive\n')
    assert.equal(bodies[6], 'after-errors\n')
  })
  if (shell === 'zsh') test('zsh honors dynamic prompt hook registration, removal and self-removal', { skip: !path }, () => {
    const startup = [
      'autoload -Uz add-zsh-hook',
      'precmd() { printf "primary:%s\\n" "$?"; PS1="primary> "; }',
      'review_old() { printf "old:%s\\n" "$?"; PS1="old> "; }',
      'review_keep() { printf "keep:%s\\n" "$?"; PS1="keep> "; }',
      'precmd_functions=(review_old review_keep)',
    ].join('\n') + '\n'
    const { output, bodies } = runFrames(shell, path, [
      ['add-zsh-hook -d precmd review_old; false', 1],
      ['review_added() { printf "added:%s\\n" "$?"; PS1="added> "; }; add-zsh-hook precmd review_added; false', 1],
      ['add-zsh-hook -d precmd review_added; false', 1],
      ['review_self() { local saved=$?; add-zsh-hook -d precmd review_self; printf "self:%s\\n" "$saved"; }; add-zsh-hook precmd review_self; false', 1],
      ['false', 1],
      ['review_register() { local saved=$?; add-zsh-hook -d precmd review_register; add-zsh-hook precmd review_added; printf "register:%s\\n" "$saved"; }; add-zsh-hook precmd review_register; false', 1],
      ['false', 1],
      ['unset precmd_functions; false', 1],
      ['printf "count:%s\\n" "${#precmd_functions[@]}"', 0],
    ], startup)
    for (const [index, suffix] of ['', 'added:1\n', '', 'self:1\n', '', 'register:1\n', 'added:1\n'].entries()) {
      const end = `__DSH_PERSISTENT_BASH_END_dcba-${index}:1\n`
      const afterCommand = output.slice(output.indexOf(end) + end.length)
      assert.ok(afterCommand.startsWith(`primary:1\nkeep:1\n${suffix}\x1b]133;D;1\x07dsh> `), afterCommand)
    }
    const end = '__DSH_PERSISTENT_BASH_END_dcba-7:1\n'
    assert.ok(output.slice(output.indexOf(end) + end.length).startsWith('primary:1\n\x1b]133;D;1\x07dsh> '), output)
    assert.equal(bodies[8], 'count:0\n')
  })
}
