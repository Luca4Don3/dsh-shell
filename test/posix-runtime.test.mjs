import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { accessSync, constants, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { inheritPosixEnvironment, initializePosixSession, posixPromptSetup, posixShellArgs, quotePosixArgument } from '../posix-runtime.mjs'

function fixture() {
  const directory = fileURLToPath(new URL('../.temp/', import.meta.url))
  mkdirSync(directory, { recursive: true })
  const home = mkdtempSync(`${directory}posix-shell-`)
  const workdir = `${home}/O'Reilly ! workspace`
  mkdirSync(workdir)
  return { home, workdir, env: { HOME: home, ZDOTDIR: home, PATH: '/usr/bin:/bin', TERM: 'dumb' } }
}

function runPty(path, args, options) {
  const fixturePath = fileURLToPath(new URL('./pty-fixture.py', import.meta.url))
  const result = spawnSync('python3', [fixturePath], { encoding: 'utf8', timeout: 10000,
    input: JSON.stringify({ argv: [path, ...args], cwd: options.cwd, env: options.env, input: options.input }) })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.timedOut, false, output.stdout)
  return output
}

function installedPath(shell) {
  if (process.platform === 'win32') return undefined
  return ['/bin', '/usr/bin', '/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin']
    .map(directory => `${directory}/${shell}`).find(path => {
      try { accessSync(path, constants.X_OK); return true } catch { return false }
    })
}

test('each POSIX shell uses its own startup options and invalid inputs fail before spawn', () => {
  for (const shell of ['zsh', 'sh', 'dash', 'ksh', 'mksh', 'ash', 'fish']) {
    assert.deepEqual(posixShellArgs({ shell }), ['-l', '-i'])
  }
  for (const shell of ['csh', 'tcsh']) assert.deepEqual(posixShellArgs({ shell }), ['-l'])
  assert.throws(() => posixShellArgs({ shell: 'zsh' }, 'pwd', 'relative'), /absolute POSIX path/)
  assert.throws(() => posixShellArgs({ shell: 'fish' }, 'x\0y'), /NUL/)
  assert.throws(() => posixShellArgs({ shell: 'unknown' }), /unsupported POSIX shell/)
})

test('POSIX session adaptation keeps DSH initialization and restores its send method even on failure', async () => {
  for (const fail of [false, true]) {
    const calls = []
    const session = { startSend(request) { calls.push(request); return { done: Promise.resolve() } },
      async initialize(signal) {
        await this.startSend({ text: '', submit: false, signal }).done
        if (fail) throw new Error('startup failed')
      } }
    const original = session.startSend
    const signal = new AbortController().signal
    initializePosixSession(session, { shell: 'zsh' }, '/workspace')
    if (fail) await assert.rejects(session.initialize(signal), /startup failed/)
    else await session.initialize(signal)
    assert.equal(session.startSend, original)
    assert.equal(calls[0].signal, signal)
    assert.equal(calls[0].submit, true)
    assert.match(calls[0].text, /133;D/)
    assert.match(calls[0].text, /cd -- '\/workspace'/)
  }
})

for (const shell of ['bash', 'zsh', 'sh', 'dash', 'ksh', 'mksh', 'ash', 'csh', 'tcsh', 'fish']) {
  const path = installedPath(shell)
  test(`${shell} really restores a quoted cwd and keeps state and completion markers`, { skip: !path }, () => {
    const { home, workdir, env } = fixture()
    const selection = { shell, path }
    const csh = ['csh', 'tcsh'].includes(shell)
    const setState = csh ? 'set DSH_TEST_STATE=alive' : shell === 'fish' ? 'set -g DSH_TEST_STATE alive' : 'DSH_TEST_STATE=alive'
    const command = csh ? 'echo state:$DSH_TEST_STATE; pwd' : 'printf "state:%s\\n" "$DSH_TEST_STATE"; pwd'
    const result = (csh || shell === 'fish' ? runPty : spawnSync)(path, posixShellArgs(selection), { cwd: home, env, encoding: 'utf8', timeout: 10000,
      killSignal: 'SIGKILL', input: [posixPromptSetup(selection, workdir), setState, command, 'false', 'exit'].join('\n') + '\n' })
    assert.equal(result.error, undefined, result.stderr)
    const output = result.stdout + result.stderr
    assert.match(output, /state:alive/)
    assert.ok(output.includes(workdir), output)
    assert.ok(output.includes('\x1b]133;D;1\x07'), JSON.stringify(output))
    const once = spawnSync(path, posixShellArgs(selection, 'pwd', workdir), { cwd: home, env,
      encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' })
    assert.equal(once.error, undefined)
    assert.equal(once.status, 0, once.stderr)
    assert.equal(once.stdout.trim(), workdir)
  })
}

test('fish as the original shell transfers exported variables without altering target argv',
  { skip: !installedPath('fish') }, () => {
    const { home, workdir, env } = fixture()
    mkdirSync(`${home}/.config/fish`, { recursive: true })
    writeFileSync(`${home}/.config/fish/config.fish`, 'set -gx ORIGINAL_CUSTOM fish-value\ncd $HOME\n')
    const value = "O'Reilly\\path !literal\n$literal `literal`"
    const argv = inheritPosixEnvironment(['/bin/sh', '-c', 'printf "%s|%s" "$ORIGINAL_CUSTOM" "$1"; pwd',
      'fixture', value], { id: 'sh', shell: 'sh', environmentShell: { shell: 'fish', path: installedPath('fish') } }, workdir)
    const result = spawnSync(argv[0], argv.slice(1), { cwd: workdir, env, encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, `fish-value|${value}${workdir}\n`)
  })

test('other POSIX shells and auto Bash inherit the original zsh startup environment and keep cwd',
  { skip: process.platform !== 'darwin' }, () => {
    const { home, workdir, env } = fixture()
    writeFileSync(`${home}/.zshenv`, 'export ORIGINAL_ENV=env-ok\n')
    writeFileSync(`${home}/.zshrc`, 'export ORIGINAL_CUSTOM=custom-value\nexport PATH="/fixture/tools:$PATH"\ncd "$HOME"\n')
    const original = { shell: 'zsh', path: '/bin/zsh' }
    for (const shell of ['bash', 'zsh', 'sh', 'dash', 'ksh', 'csh', 'tcsh']) {
      const selection = { id: shell, shell, path: `/bin/${shell}`, environmentShell: original }
      const command = 'printf "env:%s|%s|%s\\n" "$ORIGINAL_ENV" "$ORIGINAL_CUSTOM" "$PATH"; pwd'
      const argv = inheritPosixEnvironment([selection.path, ...posixShellArgs(selection, command, workdir)], selection, workdir)
      const result = spawnSync(argv[0], argv.slice(1), { cwd: workdir, env, encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' })
      assert.equal(result.error, undefined)
      assert.equal(result.status, 0, `${shell}: ${result.stderr}`)
      assert.ok(result.stdout.includes('env:env-ok|custom-value|'), `${shell}: ${result.stdout}`)
      assert.ok(result.stdout.includes('/fixture/tools'), `${shell}: ${result.stdout}`)
      assert.ok(result.stdout.includes(workdir), `${shell}: ${result.stdout}`)
    }
    const auto = { id: 'auto', shell: 'bash', environmentShell: original }
    const argv = inheritPosixEnvironment(['/bin/bash', '-c', 'printf "%s" "$ORIGINAL_CUSTOM"; pwd'], auto, workdir)
    const result = spawnSync(argv[0], argv.slice(1), { cwd: workdir, env, encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, `custom-value${workdir}\n`)
  })

test('csh/tcsh as the original shell preserve multiline target commands and special arguments',
  { skip: process.platform !== 'darwin' }, () => {
    const { home, workdir, env } = fixture()
    writeFileSync(`${home}/.cshrc`, 'setenv ORIGINAL_CUSTOM csh-value\n')
    writeFileSync(`${home}/.login`, 'setenv ORIGINAL_LOGIN login-value\ncd "$HOME"\n')
    const value = "!name\nO'Reilly\\backslash $literal `literal`"
    for (const shell of ['csh', 'tcsh']) {
      const selection = { id: 'dash', shell: 'dash', environmentShell: { shell, path: `/bin/${shell}` } }
      const command = `printf '%s|%s|%s' "$ORIGINAL_CUSTOM" "$ORIGINAL_LOGIN" ${quotePosixArgument(value, 'dash')}\npwd`
      const argv = inheritPosixEnvironment(['/bin/dash', '-c', command], selection, workdir)
      const result = spawnSync(argv[0], argv.slice(1), { cwd: workdir, env, encoding: 'utf8', timeout: 10000 })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout, `csh-value|login-value|${value}${workdir}\n`)
    }
  })

test('zsh follows user ZDOTDIR changes, reads every startup file and preserves failing user prompt hooks',
  { skip: process.platform !== 'darwin' }, () => {
    const { home, workdir, env } = fixture()
    const dotdir = `${home}/dotfiles`
    mkdirSync(dotdir)
    writeFileSync(`${home}/.zshenv`, `export ZDOTDIR='${dotdir}'\nexport DSH_TEST_ZENV=env-ok\n`)
    writeFileSync(`${dotdir}/.zprofile`, 'export DSH_TEST_ZPROFILE=profile-ok\ncd "$HOME"\n')
    writeFileSync(`${dotdir}/.zshrc`, 'export DSH_TEST_ZRC=rc-ok\nprecmd() { printf "user-status:%s\\n" "$?"; return 17; }\n')
    writeFileSync(`${dotdir}/.zlogin`, 'export DSH_TEST_ZLOGIN=login-ok\ncd "$HOME"\n')
    const selection = { shell: 'zsh' }
    const result = spawnSync('/bin/zsh', posixShellArgs(selection), { cwd: workdir, env, encoding: 'utf8', timeout: 10000,
      killSignal: 'SIGKILL', input: [posixPromptSetup(selection, workdir),
        'printf "configs:%s:%s:%s:%s\\n" "$DSH_TEST_ZENV" "$DSH_TEST_ZPROFILE" "$DSH_TEST_ZRC" "$DSH_TEST_ZLOGIN"',
        'printf "dotdir:%s\\n" "$ZDOTDIR"; pwd', 'false', 'exit'].join('\n') + '\n' })
    assert.equal(result.error, undefined, result.stderr)
    const output = result.stdout + result.stderr
    assert.ok(output.includes('configs:env-ok:profile-ok:rc-ok:login-ok'), output)
    assert.ok(output.includes(`dotdir:${dotdir}`), output)
    assert.ok(output.includes(workdir), output)
    assert.ok(output.includes('user-status:1'), output)
    assert.ok(output.includes('\x1b]133;D;1\x07'), JSON.stringify(output))
  })

for (const shell of ['csh', 'tcsh']) {
  const path = installedPath(shell)
  test(`${shell} stops multiline execution on exit and failed cwd restoration`, { skip: !path }, () => {
    const { home, workdir, env } = fixture()
    const run = (command, cwd = workdir) => spawnSync(path, posixShellArgs({ shell, path }, command, cwd),
      { cwd: home, env, encoding: 'utf8', timeout: 10000 })
    const exited = run('echo before\nexit 7\necho should-not-run')
    assert.equal(exited.error, undefined)
    assert.equal(exited.status, 7, exited.stderr)
    assert.equal(exited.stdout, 'before\n')
    const failedCwd = run('echo should-not-run', `${home}/missing`)
    assert.equal(failedCwd.error, undefined)
    assert.notEqual(failedCwd.status, 0)
    assert.equal(failedCwd.stdout, '')
    const loop = run('foreach value (first second)\necho $value\nend\nfalse')
    assert.equal(loop.status, 1, loop.stderr)
    assert.equal(loop.stdout, 'first\nsecond\n')
  })
}

function bashStartupFixture() {
  const result = fixture()
  writeFileSync(`${result.home}/.bash_profile`, 'export REVIEW_PROFILE=profile-ok\ncd "$HOME"\n')
  writeFileSync(`${result.home}/.bashrc`, [
    'case $- in *i*) ;; *) return ;; esac',
    'export REVIEW_RC=rc-ok',
    'alias review_alias="printf alias-ok"',
    'PROMPT_COMMAND=\'printf "user-status:%s\\n" "$?"\'',
    'cd "$HOME"',
  ].join('\n') + '\n')
  return result
}

const bashPath = installedPath('bash')
test('selected Bash loads login exports and bashrc aliases while retaining cwd, stdin and exit status',
  { skip: !bashPath }, () => {
    const { home, workdir, env } = bashStartupFixture()
    const selection = { id: 'bash', shell: 'bash', path: bashPath, environmentShell: { shell: 'bash', path: bashPath } }
    const command = 'review_alias\nprintf "|%s|%s|" "$REVIEW_PROFILE" "$REVIEW_RC"\nread -r value\nprintf "%s\\n" "$value"\npwd\nexit 7'
    const argv = inheritPosixEnvironment([bashPath, ...posixShellArgs(selection, command, workdir)], selection, workdir)
    const result = spawnSync(argv[0], argv.slice(1), { cwd: home, env, encoding: 'utf8', timeout: 10000, input: 'stdin-ok\n' })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 7, result.stderr)
    assert.equal(result.stdout, `alias-ok|profile-ok|rc-ok|stdin-ok\n${workdir}\n`)
  })

test('Bash as the original shell passes login and bashrc exports to another shell and auto',
  { skip: !bashPath }, () => {
    const { home, workdir, env } = bashStartupFixture()
    for (const id of ['sh', 'auto']) {
      const selection = { id, shell: id === 'auto' ? 'bash' : 'sh', environmentShell: { shell: 'bash', path: bashPath } }
      const command = 'printf "%s|%s\\n" "$REVIEW_PROFILE" "$REVIEW_RC"; pwd'
      const argv = inheritPosixEnvironment([id === 'auto' ? bashPath : '/bin/sh', '-c', command], selection, workdir)
      const result = spawnSync(argv[0], argv.slice(1), { cwd: home, env, encoding: 'utf8', timeout: 10000 })
      assert.equal(result.error, undefined)
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout, `profile-ok|rc-ok\n${workdir}\n`)
    }
  })

test('persistent Bash loads both startup files and retains aliases, state and prompt hooks',
  { skip: !bashPath }, () => {
    const { home, workdir, env } = bashStartupFixture()
    const selection = { shell: 'bash', path: bashPath }
    const result = runPty(bashPath, posixShellArgs(selection), { cwd: home, env,
      input: [posixPromptSetup(selection, workdir), 'REVIEW_STATE=alive',
        'review_alias; printf "|%s|%s|%s\\n" "$REVIEW_PROFILE" "$REVIEW_RC" "$REVIEW_STATE"; pwd',
        'false', 'exit'].join('\n') + '\n' })
    assert.ok(result.stdout.includes('alias-ok|profile-ok|rc-ok|alive'), result.stdout)
    assert.ok(result.stdout.includes(workdir), result.stdout)
    assert.ok(result.stdout.includes('user-status:1'), result.stdout)
    assert.ok(result.stdout.includes('\x1b]133;D;1\x07'), JSON.stringify(result.stdout))
  })
