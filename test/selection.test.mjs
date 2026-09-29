import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectWslDistributions, resolveSelection } from '../selection.mjs'

test('WSL detection decodes the UTF-16 output used by wsl.exe', () => {
  const distributions = detectWslDistributions('wsl.exe', () => ({
    status: 0,
    stdout: Buffer.from('Ubuntu\r\nDebian\r\nUbuntu\r\n', 'utf16le'),
  }))
  assert.deepEqual(distributions, ['Ubuntu', 'Debian'])
})

test('WSL detection does not advertise a failed installation query', () => {
  assert.deepEqual(detectWslDistributions('wsl.exe', () => ({ status: 1, stdout: Buffer.alloc(0) })), [])
})

test('platform-incompatible selections fail before launching a command', () => {
  assert.throws(() => resolveSelection({ shell: 'wsl' }, 'darwin'), /requires Windows/)
  assert.throws(() => resolveSelection({ shell: 'zsh' }, 'win32'), /select wsl on Windows/)
})

test('unused shell settings fail instead of being silently ignored', () => {
  assert.throws(() => resolveSelection({ shell: 'auto', shellPath: '/bin/zsh' }, 'darwin'), /shellPath requires/)
  assert.throws(() => resolveSelection({ shell: 'bash', wslDistribution: 'Ubuntu' }, 'darwin'), /requires wsl/)
})
