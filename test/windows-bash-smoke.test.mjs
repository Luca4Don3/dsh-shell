import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectWindowsBash } from '../selection.mjs'
import { bashProbeArgv, bashRuntimeArgv, runtimeEnvironment, validateBashProbe } from '../bash-runtime.mjs'

test('installed Windows Bash starts with user profiles, the requested cwd and one completion marker',
  { skip: process.platform !== 'win32' }, async t => {
    const installations = detectWindowsBash()
    if (process.env.GITHUB_ACTIONS === 'true') {
      assert.ok(installations.some(item => item.runtime === 'git-bash'), 'Windows CI must exercise its installed Git Bash')
    }
    if (!installations.length) return t.skip('no native Windows Bash installation detected')
    const directory = fileURLToPath(new URL('../.temp/', import.meta.url))
    mkdirSync(directory, { recursive: true })

    for (const selection of installations) await t.test(selection.label, () => {
      const home = mkdtempSync(join(directory, 'windows-bash-'))
      const workdir = join(home, "O'Reilly workspace")
      mkdirSync(workdir)
      writeFileSync(join(home, '.bash_profile'), 'export DSH_TEST_FROM_PROFILE=profile-ok\n')
      writeFileSync(join(home, '.bashrc'), 'export DSH_TEST_FROM_RC=rc-ok\nalias dsh_test_alias="printf alias-ok"\n')
      const injected = 'printf "\\033]133;D;%s\\007" "$?"; PS1="dsh> "'
      const env = runtimeEnvironment(selection, { ...process.env, HOME: home, TERM: 'dumb',
        PROMPT_COMMAND: injected, DSH_SHELL_INJECTED_PROMPT: injected })
      const run = (argv, input) => spawnSync(argv[0], argv.slice(1), {
        cwd: home, env, encoding: 'utf8', timeout: 10000, windowsHide: true, input,
      })
      const probe = run(bashProbeArgv(selection))
      assert.equal(probe.error, undefined)
      validateBashProbe(selection, { exitCode: probe.status,
        stdout: { text: probe.stdout }, stderr: { text: probe.stderr } })

      const once = run(bashRuntimeArgv(selection, workdir,
        'dsh_test_alias; printf "\\n%s|%s\\n" "$DSH_TEST_FROM_PROFILE" "$DSH_TEST_FROM_RC"; cygpath -w "$PWD"; exit 7'))
      assert.equal(once.error, undefined)
      assert.equal(once.status, 7, once.stderr)
      const lines = once.stdout.trim().split(/\r?\n/)
      assert.deepEqual(lines.slice(0, 2), ['alias-ok', 'profile-ok|rc-ok'])
      assert.equal(win32.normalize(lines[2]).toLowerCase(), win32.normalize(workdir).toLowerCase())

      const persistent = run(bashRuntimeArgv(selection, workdir, undefined, true), 'false\nexit\n')
      assert.equal(persistent.error, undefined)
      const markers = (persistent.stdout + persistent.stderr).match(/\x1b\]133;D;\d+\x07/g) ?? []
      assert.deepEqual(markers, ['\x1b]133;D;0\x07', '\x1b]133;D;1\x07'])
    })
  })
