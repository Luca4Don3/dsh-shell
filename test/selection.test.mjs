import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectWslDistributions, resolveSelection } from '../selection.mjs'

test('WSL detection supports a CLI without --status and decodes UTF-16 names', () => {
  const calls = []
  const distributions = detectWslDistributions('wsl.exe', (_program, args) => {
    calls.push(args)
    if (args[1] === '--quiet') return { status: 0, stdout: Buffer.from('Ubuntu\r\nDebian\r\nUbuntu\r\n', 'utf16le') }
    return { status: 1, stderr: Buffer.from('Invalid command line option') }
  })
  assert.deepEqual(distributions, ['Ubuntu', 'Debian'])
  assert.deepEqual(calls, [['--list', '--quiet'], ['--list', '--verbose'], ['--help']])
})

test('WSL detection hides the option when distribution queries fail, time out or are empty', () => {
  for (const result of [
    { status: 1 },
    { status: null, error: new Error('ETIMEDOUT') },
    { status: 0, stdout: Buffer.alloc(0) },
  ]) assert.deepEqual(detectWslDistributions('wsl.exe', () => result), [])
  assert.deepEqual(detectWslDistributions(undefined), [])
})

test('WSL selection uses a detected distribution and rejects an absent one', () => {
  const available = [{ id: 'wsl', path: 'wsl.exe', distributions: ['Debian'] }]
  assert.equal(resolveSelection({ shell: 'wsl' }, 'win32', {}, available).distribution, 'Debian')
  assert.throws(() => resolveSelection({ shell: 'wsl', wslDistribution: 'Ubuntu' }, 'win32', {}, available), /not installed/)
  assert.throws(() => resolveSelection({ shell: 'wsl' }, 'win32', {}, []), /unavailable/)
})

test('platform-incompatible selections fail before launching a command', () => {
  assert.throws(() => resolveSelection({ shell: 'wsl' }, 'darwin'), /requires Windows/)
  assert.throws(() => resolveSelection({ shell: 'zsh' }, 'win32'), /select wsl on Windows/)
})

test('unused shell settings fail instead of being silently ignored', () => {
  assert.throws(() => resolveSelection({ shell: 'auto', shellPath: '/bin/zsh' }, 'darwin'), /shellPath requires/)
  assert.throws(() => resolveSelection({ shell: 'bash', wslDistribution: 'Ubuntu' }, 'darwin'), /requires wsl/)
})

test('one component serves every Windows selection', () => {
  assert.deepEqual(resolveSelection({ shell: 'auto' }, 'win32', {}, []), { id: 'auto', dialect: 'pwsh' })
  const wsl = resolveSelection({ shell: 'wsl' }, 'win32', {}, [{ id: 'wsl', path: 'wsl.exe', distributions: ['Debian'] }])
  assert.equal(wsl.id, 'wsl')
  assert.equal(wsl.dialect, 'bash')
  assert.equal(wsl.distribution, 'Debian')
})

test('auto keeps the shipped one-shot path on a POSIX host', { skip: process.platform === 'win32' ? 'needs a POSIX host' : false }, () => {
  const selection = resolveSelection({ shell: 'auto' }, 'darwin', {}, [])
  assert.equal(selection.id, 'auto')
  assert.equal(selection.shell, 'bash')
  assert.equal(selection.dialect, 'bash')
})
