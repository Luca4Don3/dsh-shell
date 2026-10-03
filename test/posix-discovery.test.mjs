import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { detectPosixShells, resolveSelection } from '../selection.mjs'

test('POSIX discovery covers system shells, Homebrew, MacPorts, PATH and /etc/shells without executing them', () => {
  const paths = new Set(['/bin/bash', '/opt/homebrew/bin/bash', '/bin/zsh', '/bin/sh', '/bin/dash', '/bin/ksh',
    '/bin/csh', '/bin/tcsh', '/opt/local/bin/fish', '/custom/ash', '/registered/mksh', '/alias/bash'])
  const options = { present: path => paths.has(path), read: () => '# shells\n/registered/mksh\n/missing/zsh\n',
    realpath: path => path === '/alias/bash' ? '/opt/homebrew/bin/bash' : path }
  const found = detectPosixShells({ PATH: '/alias:/custom' }, options)
  assert.equal(found.filter(item => item.shell === 'bash').length, 2)
  assert.equal(found.find(item => item.shell === 'bash').path, '/bin/bash')
  assert.equal(found.find(item => item.shell === 'fish').dialect, 'fish')
  assert.equal(found.find(item => item.shell === 'tcsh').dialect, 'csh')
  assert.ok(found.some(item => item.path === '/registered/mksh'))
  assert.ok(found.some(item => item.path === '/custom/ash'))
  const reordered = detectPosixShells({ PATH: '/custom:/alias' }, options)
  assert.deepEqual(found.map(item => item.id), reordered.map(item => item.id))
})

test('POSIX installation IDs survive removal and insertion of an earlier installation', () => {
  const discover = paths => detectPosixShells({ PATH: '' }, {
    present: path => paths.includes(path), read: () => '', realpath: path => path,
  })
  const first = '/opt/homebrew/bin/fish', second = '/usr/local/bin/fish'
  const before = discover([first, second])
  const after = discover([second])
  assert.equal(before.find(item => item.path === second).id, after[0].id)
  assert.equal(discover([first])[0].id, before.find(item => item.path === first).id)
  assert.ok(before.every(item => item.id.startsWith('posix-fish:')))
})

test('legacy family names and existing hashed selections both resolve', { skip: process.platform === 'win32' }, () => {
  const installed = [{ id: 'posix-sh:fixture', shell: 'sh', path: '/bin/sh' }]
  for (const shell of ['sh', installed[0].id]) {
    const resolved = resolveSelection({ shell }, process.platform, { SHELL: '/bin/sh' }, installed)
    assert.equal(resolved.path, '/bin/sh')
    assert.equal(resolved.shell, 'sh')
  }
})

test('POSIX discovery excludes nonexecutable files and broken symlinks', { skip: process.platform === 'win32' }, () => {
  const directory = fileURLToPath(new URL('../.temp/', import.meta.url))
  mkdirSync(directory, { recursive: true })
  const root = mkdtempSync(`${directory}shell-discovery-`)
  writeFileSync(`${root}/bash`, '#!/bin/sh\n')
  chmodSync(`${root}/bash`, 0o644)
  symlinkSync(`${root}/missing`, `${root}/fish`)
  assert.ok(detectPosixShells({ PATH: root }).every(item => !item.path.startsWith(root)))
  assert.throws(() => resolveSelection({ shell: 'bash', shellPath: `${root}/bash` }, 'darwin'), /executable was not found/)
})

test('POSIX installation ids resolve to their family and are rejected on Windows', { skip: process.platform === 'win32' }, () => {
  const installed = [{ id: 'posix-dash:test', shell: 'dash', path: '/bin/dash', label: 'dash installation' }]
  const resolved = resolveSelection({ shell: installed[0].id }, 'darwin', {}, installed)
  assert.equal(resolved.shell, 'dash')
  assert.equal(resolved.dialect, 'posix')
  assert.throws(() => resolveSelection({ shell: installed[0].id }, 'win32', {}, installed), /requires a POSIX host/)
  assert.throws(() => resolveSelection({ shell: 'fish' }, 'win32'), /requires a POSIX host/)
})
