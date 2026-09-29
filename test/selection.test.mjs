import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectWslDistributions, resolveSelection } from '../selection.mjs'

test('WSL detection decodes the UTF-16 output used by wsl.exe', () => {
  const calls = []
  const distributions = detectWslDistributions('wsl.exe', (_program, args) => {
    calls.push(args)
    return args[0] === '--list'
      ? { status: 0, stdout: Buffer.from('Ubuntu\r\nDebian\r\nUbuntu\r\n', 'utf16le') }
      : { status: 0 }
  })
  assert.deepEqual(distributions, ['Ubuntu', 'Debian'])
  assert.deepEqual(calls, [['--status'], ['--list', '--quiet']])
})

test('WSL detection hides the option when installation status fails', () => {
  const calls = []
  assert.deepEqual(detectWslDistributions('wsl.exe', (_program, args) => {
    calls.push(args)
    return { status: 1 }
  }), [])
  assert.deepEqual(calls, [['--status']])
})

test('WSL detection hides the option when the distribution query fails or is empty', () => {
  const distributions = detectWslDistributions('wsl.exe', (_program, args) => {
    if (args[0] === '--status') return { status: 0 }
    return { status: 1, stdout: Buffer.alloc(0) }
  })
  assert.deepEqual(distributions, [])
  assert.deepEqual(detectWslDistributions('wsl.exe', (_program, args) => args[0] === '--status'
    ? { status: 0 }
    : { status: 0, stdout: Buffer.alloc(0) }), [])
})

test('WSL detection hides a timed-out status check', () => {
  const distributions = detectWslDistributions('wsl.exe', () => ({ status: null, error: new Error('ETIMEDOUT') }))
  assert.deepEqual(distributions, [])
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
