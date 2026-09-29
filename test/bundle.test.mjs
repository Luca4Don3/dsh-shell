import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const shell = readFileSync(new URL('../shell.mjs', import.meta.url), 'utf8')

function row(id) {
  const start = patch.indexOf(`- id: ${id}\n`)
  if (start < 0) return ''
  const rest = patch.slice(start + 1)
  const end = rest.search(/^\s*- id: /m)
  return end < 0 ? rest : rest.slice(0, end)
}

test('the bundle declares one shell component for every platform', () => {
  const ids = [...patch.matchAll(/^\s*- id: (\S+)\s*$/gm)].map((match) => match[1])
  assert.deepEqual(ids.filter((id) => id.startsWith('selected-')), ['selected-shell'])
  assert.doesNotMatch(patch, /dsh-shell\/shell-windows/)
})

test('the shell component is never disabled by a platform expression', () => {
  assert.doesNotMatch(row('selected-shell'), /disabled:/)
  assert.doesNotMatch(row('selected-shell'), /process\.platform/)
  assert.match(row('selected-shell'), /name: dsh-shell\/shell/)
})

test('the shell module exports the executor its platform needs', () => {
  assert.match(shell, /import \{ SelectedWindowsExecutor \} from '\.\/shell-windows\.mjs'/)
  assert.match(shell, /export default process\.platform === 'win32'\s*\?\s*SelectedWindowsExecutor\s*:\s*SelectedPosixExecutor/)
  assert.match(shell, /export function quoteForBash\(value\)/)
})
