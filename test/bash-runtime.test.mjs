import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { assertBashPolicy, assertWindowsWorkdir, bashProbeArgv, bashRuntimeArgv, quoteBash, runtimeEnvironment, validateBashProbe } from '../bash-runtime.mjs'

const wsl = { id: 'wsl', path: 'C:\\Windows\\System32\\wsl.exe', distribution: 'Ubuntu Dev', supportsCd: true }
const git = { id: 'git-bash:test', runtime: 'git-bash', path: 'C:\\Program Files\\Git\\bin\\bash.exe' }
const workdir = "C:\\工作区\\O'Reilly project"

test('WSL launch preserves the exact distribution and adapts to --cd support', () => {
  const argv = bashRuntimeArgv(wsl, workdir, 'printf "%s" "$HOME"')
  assert.deepEqual(argv.slice(0, 8), [wsl.path, '--distribution', 'Ubuntu Dev', '--cd', workdir, '--exec', '/bin/bash', '-lc'])
  assert.equal(argv.at(-1), 'printf "%s" "$HOME"')
  const legacy = bashRuntimeArgv({ ...wsl, supportsCd: false }, workdir, 'pwd')
  assert.ok(!legacy.includes('--cd'))
  assert.match(legacy[6], /wslpath -u/)
  assert.deepEqual(bashProbeArgv(wsl).slice(0, 5), [wsl.path, '--distribution', 'Ubuntu Dev', '--exec', '/bin/bash'])
})

test('native Bash uses its selected executable and cygpath, with safe quoting', () => {
  for (const runtime of ['git-bash', 'msys2', 'cygwin']) {
    const argv = bashRuntimeArgv({ ...git, runtime }, workdir, 'pwd')
    assert.equal(argv[0], git.path)
    assert.match(argv[2], /cygpath -u/)
    assert.equal(argv.at(-1), 'pwd')
  }
  assert.throws(() => quoteBash('x\0y'), /NUL/)
})

test('Linux cwd, root-relative paths and relative paths are rejected before a Windows spawn', () => {
  for (const path of ['/linux-test-home/project', '\\project', 'relative', 'C:relative']) {
    assert.throws(() => assertWindowsWorkdir(path), /absolute Windows path/)
  }
  for (const path of [workdir, '\\\\server\\share\\project', '//test-host/test-share/project', 'D:/workspace']) assertWindowsWorkdir(path)
})

test('WSL policy fails before any capability check; native Bash retains confined modes', () => {
  for (const mode of ['read-only', 'workspace-write']) assert.throws(() => assertBashPolicy(wsl, { mode }), /cannot be confined/)
  assertBashPolicy(wsl, { mode: 'danger-full-access' })
  assertBashPolicy(git, { mode: 'workspace-write' })
})

test('capability results require real Bash and the matching OS; failure remains explicit', () => {
  const result = { exitCode: 0, stdout: { text: '__DSH_BASH_RUNTIME__5.2.15\n__DSH_BASH_OS__Linux\n' }, stderr: { text: '' } }
  assert.equal(validateBashProbe(wsl, result).version, '5.2.15')
  assert.throws(() => validateBashProbe(git, result), /capability check/)
  assert.throws(() => validateBashProbe(wsl, { ...result, timedOut: true }), /timed out/)
  assert.throws(() => validateBashProbe(wsl, { ...result, aborted: true }), /cancelled/)
  assert.throws(() => validateBashProbe(wsl, { ...result, exitCode: 1, stderr: { text: 'execvpe(/bin/bash) failed: No such file or directory' } }), /No such file/)
})

test('WSL inherits host variables and explicit overrides, preserves flags and keeps Linux HOME/PATH', () => {
  const env = runtimeEnvironment(wsl, { WSLENV: 'EXISTING/p:DSH_SESSION_ID', EXISTING: 'value', DSH_SESSION_ID: 'test', DSH_WORKSPACE: 'C:\\workspace' })
  assert.equal(env.WSLENV, 'EXISTING/p:DSH_SESSION_ID:DSH_WORKSPACE:DSH_SHELL_WINDOWS_PATH/pl')
  const inherited = runtimeEnvironment(wsl, { Custom: 'explicit', Path: 'D:\\Tools;C:\\Windows',
    WSLENV: 'PATH/pl:HOME/p:custom/u:Project/p:ProgramFiles(x86)/p' }, {
    CUSTOM: 'ambient', PATH: 'C:\\Windows', HOME: 'C:\\dsh-test-home', Project: 'D:\\Project',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)', LANG: 'en_US.UTF-8',
  })
  assert.equal(inherited.Custom, 'explicit')
  assert.equal(inherited.CUSTOM, undefined)
  assert.equal(inherited.PATH, undefined)
  assert.equal(inherited.DSH_SHELL_WINDOWS_PATH, 'D:\\Tools;C:\\Windows')
  assert.equal(inherited.WSLENV, 'Custom/u:Project/p:ProgramFiles(x86)/p:LANG:DSH_SHELL_WINDOWS_PATH/pl')
  assert.throws(() => runtimeEnvironment(wsl, { 'invalid/name': 'value' }), /cannot be forwarded/)
  assert.equal(runtimeEnvironment(git, {}).CHERE_INVOKING, '1')
})

function runControlledBash(persistent, command, input, options = {}) {
  const directory = fileURLToPath(new URL('../.temp/', import.meta.url))
  mkdirSync(directory, { recursive: true })
  const home = mkdtempSync(`${directory}bash-fixture-`)
  writeFileSync(`${home}/.bashrc`, options.rc ?? 'export DSH_TEST_FROM_RC=loaded\nalias dsh_test_alias="printf alias-ok"\nPROMPT_COMMAND="printf user-hook"\n')
  if (options.profile) writeFileSync(`${home}/.bash_profile`, options.profile)
  const generated = bashRuntimeArgv({ ...git, ...(options.wsl ? { id: 'wsl', distribution: 'fixture', supportsCd: false } : {}), path: '/bin/bash' }, workdir, command, persistent)
  if (options.wsl) generated.splice(1, 4) // Execute Linux argv after simulated wsl.exe transport.
  const bootstrap = 'cygpath() { [ "$1" = -u ] && [ "$2" = "$DSH_TEST_HOST_CWD" ] || return 9; printf "%s" "$DSH_TEST_GUEST_CWD"; }; wslpath() { cygpath "$@"; }; export -f cygpath wslpath; exec "$@"'
  return { home, result: spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', bootstrap, 'fixture', ...generated], {
    cwd: home, env: { PATH: '/usr/bin:/bin', HOME: home, TERM: 'dumb', DSH_TEST_HOST_CWD: workdir, DSH_TEST_GUEST_CWD: home, ...options.env },
    encoding: 'utf8', timeout: 10000, input,
  }) }
}

test('the generated one-shot Bash really sources bashrc, retains aliases and restores cwd with quoted Windows paths', { skip: process.platform === 'win32' }, () => {
  const { home, result } = runControlledBash(false, 'dsh_test_alias; printf "|%s|%s" "$DSH_TEST_FROM_RC" "$PWD"; exit 7')
  assert.equal(result.error, undefined)
  assert.equal(result.status, 7, result.stderr)
  assert.equal(result.stdout, `alias-ok|loaded|${home}`)
})

test('the generated persistent Bash preserves user prompt hooks and reports the previous exit code', { skip: process.platform === 'win32' }, () => {
  const { result } = runControlledBash(true, undefined, 'false\nexit\n')
  assert.equal(result.error, undefined)
  assert.match(result.stdout + result.stderr, /user-hook/)
  assert.ok((result.stdout + result.stderr).includes('\x1b]133;D;1\x07'), JSON.stringify(result.stdout + result.stderr))
})

test('user prompt hooks observe the previous command exit status', { skip: process.platform === 'win32' }, () => {
  const { result } = runControlledBash(true, undefined, 'false\nexit\n', {
    rc: 'PROMPT_COMMAND=\'printf "user-status:%s\\n" "$?"\'\n',
  })
  assert.equal(result.error, undefined)
  assert.match(result.stdout, /user-status:1\n/)
  assert.ok((result.stdout + result.stderr).includes('\x1b]133;D;1\x07'))
})
test('DSH-injected prompt markers are replaced once when bashrc has no user prompt hook', { skip: process.platform === 'win32' }, () => {
  const injected = 'printf "\\033]133;D;%s\\007" "$?"; PS1="dsh> "'
  const { result } = runControlledBash(true, undefined, 'false\nexit\n', {
    rc: 'export DSH_TEST_FROM_RC=loaded\n',
    env: { PROMPT_COMMAND: injected, DSH_SHELL_INJECTED_PROMPT: injected },
  })
  assert.equal(result.error, undefined)
  const markers = (result.stdout + result.stderr).match(/\x1b\]133;D;\d+\x07/g) ?? []
  assert.deepEqual(markers, ['\x1b]133;D;0\x07', '\x1b]133;D;1\x07'])
})

test('a login profile prompt hook survives removing the DSH-injected default', { skip: process.platform === 'win32' }, () => {
  const { result } = runControlledBash(true, undefined, 'false\nexit\n', {
    rc: 'export DSH_TEST_FROM_RC=loaded\n', profile: 'PROMPT_COMMAND="printf login-hook"\n',
    env: { PROMPT_COMMAND: 'printf injected-hook', DSH_SHELL_INJECTED_PROMPT: 'printf injected-hook' },
  })
  assert.equal(result.error, undefined)
  assert.match(result.stdout, /login-hook/)
  assert.doesNotMatch(result.stdout, /injected-hook/)
  assert.ok((result.stdout + result.stderr).includes('\x1b]133;D;1\x07'))
})

test('Git Bash uses its installation architecture and explicit MSYSTEM still wins', () => {
  assert.equal(runtimeEnvironment({ ...git, msystem: 'MINGW32' }).MSYSTEM, 'MINGW32')
  assert.equal(runtimeEnvironment({ ...git, msystem: 'CLANGARM64' }).MSYSTEM, 'CLANGARM64')
  assert.equal(runtimeEnvironment({ ...git, msystem: 'MINGW64' }, { MSYSTEM: 'CUSTOM' }).MSYSTEM, 'CUSTOM')
  assert.equal(runtimeEnvironment(git).MSYSTEM, undefined)
})

test('WSL startup merges already converted Windows PATH after bashrc without replacing HOME', { skip: process.platform === 'win32' }, () => {
  for (const persistent of [false, true]) {
    const command = 'printf "env:%s|%s|%s|%s\\n" "$CUSTOM_VALUE" "$PATH" "$HOME" "${DSH_SHELL_WINDOWS_PATH-unset}"'
    const { home, result } = runControlledBash(persistent, command, `${command}\nexit\n`, {
      wsl: true, rc: 'export PATH=/usr/bin:/bin:/linux/tools\n',
      env: { CUSTOM_VALUE: 'host-value', DSH_SHELL_WINDOWS_PATH: '/bin:/windows-test-mount/c/Program Files/tools::/windows-test-mount/d/tools:/windows-test-mount/d/tools' },
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stderr)
    assert.ok(result.stdout.includes(`env:host-value|/usr/bin:/bin:/linux/tools:/windows-test-mount/c/Program Files/tools:/windows-test-mount/d/tools|${home}|unset`), result.stdout)
  }
})

test('MSYS2 CLANG architectures pass the real Bash capability contract', () => {
  for (const os of ['CLANG64_NT-10.0', 'CLANGARM64_NT-10.0']) {
    assert.equal(validateBashProbe({ ...git, runtime: 'msys2' }, { exitCode: 0,
      stdout: { text: `__DSH_BASH_RUNTIME__5.2\n__DSH_BASH_OS__${os}\n` } }).os, os)
  }
})
