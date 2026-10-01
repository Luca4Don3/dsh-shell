import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeWslOutput, detectInstalledShells, detectWindowsBash, detectWsl, identifyWindowsBash, parseWslVerbose, resolveSelection } from '../selection.mjs'

function wslRunner({ names = 'Ubuntu Dev\r\nDebian\r\n', verbose = '  NAME           STATE       VERSION\r\n  Ubuntu Dev     Stopped     1\r\n* Debian         Running     2\r\n', quietStatus = 0, verboseStatus = 0, help = '--cd <Directory>' } = {}) {
  return (_path, args) => ({ status: args[1] === '--quiet' ? quietStatus : args[1] === '--verbose' ? verboseStatus : 0,
    stdout: Buffer.from(args[1] === '--quiet' ? names : args[1] === '--verbose' ? verbose : help, 'utf16le') })
}

test('WSL metadata keeps the per-distribution version, state and default, including names with spaces', () => {
  const result = detectWsl('wsl.exe', wslRunner())
  assert.deepEqual(result.distributions, [
    { name: 'Debian', state: 'Running', version: 2, isDefault: true },
    { name: 'Ubuntu Dev', state: 'Stopped', version: 1, isDefault: false },
  ])
  assert.equal(result.supportsCd, true)
  const selection = resolveSelection({ shell: 'wsl' }, 'win32', {}, [{ id: 'wsl', path: 'wsl.exe',
    distributions: ['Ubuntu Dev', 'Debian'], distributionDetails: result.distributions, supportsCd: true }])
  assert.equal(selection.distribution, 'Debian')
  assert.equal(selection.wslVersion, 2)
})

test('localized states, UTF-8/UTF-16 BOMs and unknown future versions survive detection', () => {
  assert.equal(decodeWslOutput(Buffer.from('\uFEFFUbuntu\r\n', 'utf16le')), 'Ubuntu\r\n')
  assert.equal(decodeWslOutput(Buffer.from('\uFEFFDebian\n')), 'Debian\n')
  assert.deepEqual(parseWslVerbose('* 测试 Linux      已停止      3\n', ['测试 Linux']), [
    { name: '测试 Linux', state: '已停止', version: 3, isDefault: true },
  ])
})

test('verbose metadata can recover a failed quiet listing, without starting a distro', () => {
  const calls = []
  const run = wslRunner({ quietStatus: 1 })
  const result = detectWsl('wsl.exe', (path, args) => { calls.push(args); return run(path, args) })
  assert.equal(result.distributions.length, 2)
  assert.ok(calls.every(args => !args.includes('--exec') && !args.includes('--status')))
})

test('old CLIs retain names with unknown versions and require an explicit selection if the default is unknown', () => {
  const warnings = []
  const result = detectWsl('wsl.exe', wslRunner({ verboseStatus: 1, help: '--exec <CommandLine>' }), warning => warnings.push(warning))
  assert.equal(result.supportsCd, false)
  assert.equal(result.distributions[0].version, null)
  assert.equal(warnings.length, 1)
  const inventory = [{ id: 'wsl', path: 'wsl.exe', distributions: result.distributions.map(item => item.name), distributionDetails: result.distributions }]
  assert.throws(() => resolveSelection({ shell: 'wsl' }, 'win32', {}, inventory), /select a WSL distribution explicitly/)
  assert.equal(resolveSelection({ shell: 'wsl', wslDistribution: 'Ubuntu Dev' }, 'win32', {}, inventory).distribution, 'Ubuntu Dev')
})

test('failed metadata queries report diagnostics and malformed rows do not become distributions', () => {
  const warnings = []
  assert.equal(detectWsl('wsl.exe', () => ({ status: null, error: new Error('ETIMEDOUT') }), warning => warnings.push(warning)).distributions.length, 0)
  assert.match(warnings[0], /ETIMEDOUT/)
  const result = detectWsl('wsl.exe', wslRunner({ names: 'Ubuntu\n', verbose: '* WrongName     Running     2\n' }))
  assert.deepEqual(result.distributions, [{ name: 'Ubuntu', version: null, state: null, isDefault: false }])
})

const files = new Set([
  'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\msys-2.0.dll', 'C:\\Program Files\\Git\\cmd\\git.exe',
  'D:\\Portable Git\\bin\\bash.exe', 'D:\\Portable Git\\usr\\bin\\msys-2.0.dll', 'D:\\Portable Git\\cmd\\git.exe',
  'C:\\msys64\\usr\\bin\\bash.exe', 'C:\\msys64\\usr\\bin\\msys-2.0.dll', 'C:\\msys64\\usr\\bin\\pacman.exe',
  'C:\\cygwin64\\bin\\bash.exe', 'C:\\cygwin64\\bin\\cygwin1.dll',
  'C:\\Windows\\System32\\bash.exe',
].map(path => path.toLowerCase()))
const present = path => files.has(path.toLowerCase())
const env = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', PATH: 'C:\\Windows\\System32;"D:\\Portable Git\\bin";C:\\Program Files\\Git\\usr\\bin' }

test('Windows inventory distinguishes and deduplicates Git Bash, MSYS2 and Cygwin installations', () => {
  const found = detectWindowsBash(env, { present })
  assert.deepEqual(found.map(item => item.runtime), ['git-bash', 'msys2', 'cygwin', 'git-bash'])
  assert.equal(new Set(found.map(item => item.id)).size, 4)
  assert.ok(found.every(item => !item.path.includes('System32')))
  const reversed = detectWindowsBash({ ...env, PATH: env.PATH.split(';').reverse().join(';') }, { present })
  assert.deepEqual(new Set(found.map(item => item.id)), new Set(reversed.map(item => item.id)))
  for (const item of found) {
    const selection = resolveSelection({ shell: item.id }, 'win32', {}, found)
    assert.equal(selection.path, item.path)
    assert.equal(selection.dialect, 'bash')
    assert.throws(() => resolveSelection({ shell: item.id }, 'darwin', {}, found), /requires Windows/)
  }
})

test('Git registry paths find nonstandard installations without launching Bash', () => {
  const calls = []
  const inventory = detectWindowsBash({ SystemRoot: 'C:\\Windows' }, {
    present: path => present(path) || path.endsWith('reg.exe'),
    run: (path, args) => {
      calls.push({ path, args })
      return { status: 0, stdout: Buffer.from('    InstallPath    REG_SZ    D:\\Portable Git\r\n') }
    },
  })
  assert.ok(inventory.some(item => item.root === 'D:\\Portable Git'))
  assert.equal(calls.length, 2)
  assert.ok(calls.every(call => call.path.endsWith('reg.exe')))
})

test('a failed WSL installation does not hide detected native Bash or alter auto', () => {
  const found = detectInstalledShells('win32', env, { present: path => present(path) || path.endsWith('wsl.exe'), run: () => ({ status: 1 }) })
  assert.ok(found.some(item => item.runtime === 'git-bash'))
  assert.ok(!found.some(item => item.id === 'wsl'))
  assert.deepEqual(resolveSelection({ shell: 'auto' }, 'win32', env, found), { id: 'auto', dialect: 'pwsh' })
})

test('distribution names sharing a prefix retain their own versions and default markers', () => {
  assert.deepEqual(parseWslVerbose('  Ubuntu         Stopped   1\n* Ubuntu Dev     Running   2\n', ['Ubuntu', 'Ubuntu Dev']), [
    { name: 'Ubuntu', state: 'Stopped', version: 1, isDefault: false },
    { name: 'Ubuntu Dev', state: 'Running', version: 2, isDefault: true },
  ])
})
test('Git Bash architecture is determined from the selected installation, not ProgramFiles or the host CPU', () => {
  const root = 'D:\\Git'
  for (const [directory, msystem] of [['mingw32', 'MINGW32'], ['mingw64', 'MINGW64'], ['clangarm64', 'CLANGARM64']]) {
    const paths = new Set([`${root}\\usr\\bin\\msys-2.0.dll`, `${root}\\cmd\\git.exe`, `${root}\\${directory}\\bin\\git.exe`])
    assert.equal(identifyWindowsBash(`${root}\\bin\\bash.exe`, path => paths.has(path)).msystem, msystem)
  }
})
