import { accessSync, constants, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, delimiter, join, win32 } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { userInfo } from 'node:os'
import { posixDialect, posixShells } from './posix-runtime.mjs'

function exists(path) {
  try {
    const info = lstatSync(path)
    return info.isFile() || info.isSymbolicLink()
  } catch {
    return false
  }
}

function executable(path) {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function environmentShell(env) {
  const path = env.SHELL || userInfo().shell || '/bin/sh'
  const shell = basename(path)
  if (!posixShells.includes(shell) || !executable(path)) {
    throw new Error(`dsh-shell: the original user shell ${JSON.stringify(path)} is unavailable or unsupported`)
  }
  return { shell, path }
}

function onPaths(command, env, platform, present = exists) {
  const names = platform === 'win32' && !/\.exe$/i.test(command) ? [`${command}.exe`, command] : [command]
  const pathJoin = platform === 'win32' ? win32.join : join
  return (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter).flatMap(entry => {
    const directory = platform === 'win32' ? entry.trim().replace(/^"|"$/g, '') : entry
    return directory ? names.map(name => pathJoin(directory, name)).filter(present) : []
  })
}

function windowsPrograms(env, present = exists) {
  const root = env.SystemRoot ?? 'C:\\Windows'
  const pwsh = [win32.join(env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    ...onPaths('pwsh', env, 'win32', present)].find(path => path && present(path))
  const powershell = win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const wsl = [win32.join(root, 'System32', 'wsl.exe'), ...onPaths('wsl', env, 'win32', present)].find(path => path && present(path))
  return { pwsh, powershell: present(powershell) ? powershell : undefined, wsl }
}

export function decodeWslOutput(bytes = Buffer.alloc(0)) {
  if (typeof bytes === 'string') return bytes.replace(/^\uFEFF/, '').replaceAll('\u0000', '')
  return bytes.toString(bytes.includes(0) ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '').replaceAll('\u0000', '')
}

export function parseWslVerbose(output, names = []) {
  return output.split(/\r?\n/).flatMap(line => {
    const isDefault = /^\s*\*/.test(line)
    const text = line.replace(/^\s*\*?\s*/, '').trim()
    const match = text.match(/\s+(\d+)$/)
    if (!match) return []
    const columns = text.slice(0, match.index).trimEnd()
    const name = [...names].sort((a, b) => b.length - a.length).find(name => columns.startsWith(name) && /^\s/.test(columns.slice(name.length)))
    if (names.length && !name) return []
    const parts = columns.split(/\s{2,}/)
    if (!name && parts.length !== 2) return []
    return [{ name: name ?? parts[0], state: name ? columns.slice(name.length).trim() : parts[1],
      version: Number(match[1]), isDefault }]
  })
}

export function detectWsl(wsl, run = spawnSync, report = () => {}) {
  if (!wsl) return { distributions: [], supportsCd: false }
  // Metadata commands must not start a distribution before the sandbox policy check.
  const options = { timeout: 3000, windowsHide: true }
  const quiet = run(wsl, ['--list', '--quiet'], options)
  const verbose = run(wsl, ['--list', '--verbose'], options)
  const ok = result => !result.error && result.status === 0
  const names = ok(quiet) ? [...new Set(decodeWslOutput(quiet.stdout).split(/\r?\n/).map(name => name.trim()).filter(Boolean))] : []
  const details = ok(verbose) ? parseWslVerbose(decodeWslOutput(verbose.stdout), names) : []
  if (!ok(quiet) && !details.length) {
    report(`WSL distribution query failed: ${quiet.error?.message || decodeWslOutput(quiet.stderr).trim() || `exit ${quiet.status}`}`)
    return { distributions: [], supportsCd: false }
  }
  if (!ok(verbose) && names.length) report('WSL verbose listing unavailable; distribution versions and default may be unknown')
  const distributions = (names.length ? names.map(name => details.find(item => item.name === name)
    ?? { name, version: null, state: null, isDefault: false }) : details)
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
  if (!distributions.length) return { distributions: [], supportsCd: false }
  const help = run(wsl, ['--help'], options)
  return { distributions, supportsCd: ok(help) && /(?:^|\s)--cd(?:\s|$)/m.test(decodeWslOutput(help.stdout)) }
}

export function detectWslDistributions(wsl, run = spawnSync) {
  return detectWsl(wsl, run).distributions.map(item => item.name)
}

export function identifyWindowsBash(path, present = exists) {
  if (win32.basename(path).toLowerCase() !== 'bash.exe') return
  const directory = win32.dirname(path)
  const root = /\\usr\\bin$/i.test(directory) ? win32.dirname(win32.dirname(directory)) : win32.dirname(directory)
  if (present(win32.join(directory, 'cygwin1.dll'))) return { runtime: 'cygwin', root }
  const msysDirectory = win32.join(root, 'usr', 'bin')
  if (!present(win32.join(msysDirectory, 'msys-2.0.dll'))) return
  if (present(win32.join(root, 'cmd', 'git.exe'))) {
    const directory = ['clangarm64', 'mingw64', 'mingw32']
      .find(name => present(win32.join(root, name, 'bin', 'git.exe')))
    return { runtime: 'git-bash', root, msystem: directory?.toUpperCase() }
  }
  if (present(win32.join(msysDirectory, 'pacman.exe'))) return { runtime: 'msys2', root }
}

export function detectWindowsBash(env = process.env, { present = exists, run = spawnSync } = {}) {
  const systemRoot = env.SystemRoot ?? 'C:\\Windows'
  const roots = [env.ProgramFiles ?? 'C:\\Program Files', env['ProgramFiles(x86)'],
    env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Programs')].filter(Boolean).map(path => win32.join(path, 'Git'))
  const reg = win32.join(systemRoot, 'System32', 'reg.exe')
  if (present(reg)) {
    for (const hive of ['HKCU', 'HKLM']) {
      const result = run(reg, ['query', `${hive}\\Software\\GitForWindows`, '/v', 'InstallPath'], { timeout: 3000, windowsHide: true })
      const path = !result.error && result.status === 0
        ? decodeWslOutput(result.stdout).match(/InstallPath\s+REG_SZ\s+(.+)/i)?.[1]?.trim() : undefined
      if (path) roots.push(path)
    }
  }
  roots.push(env.MSYS2_ROOT, env.CYGWIN_ROOT,
    ...['msys64', 'msys32', 'cygwin64', 'cygwin'].map(name => win32.join(win32.parse(systemRoot).root, name)))
  const candidates = [...roots.filter(Boolean).flatMap(root => [win32.join(root, 'bin', 'bash.exe'), win32.join(root, 'usr', 'bin', 'bash.exe')]),
    ...onPaths('bash', env, 'win32', present)]
  const found = new Map()
  for (const path of candidates) {
    if (!present(path)) continue
    const identity = identifyWindowsBash(path, present)
    if (!identity) continue // System32/bash.exe is a legacy WSL launcher, not native Bash.
    const key = win32.normalize(identity.root).toLowerCase()
    if (found.has(key)) continue
    const suffix = createHash('sha256').update(key).digest('hex').slice(0, 12)
    found.set(key, { id: `${identity.runtime}:${suffix}`, ...identity, path,
      label: `${{ 'git-bash': 'Git Bash', msys2: 'MSYS2', cygwin: 'Cygwin' }[identity.runtime]} · ${identity.root}` })
  }
  return [...found.values()]
}

export function detectPosixShells(env = process.env, { present = executable, read = readFileSync, realpath = realpathSync } = {}) {
  let registered = []
  try {
    registered = read('/etc/shells', 'utf8').split(/\r?\n/).map(line => line.split('#')[0].trim()).filter(Boolean)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return posixShells.flatMap(shell => {
    const candidates = [...new Set([
      ...['/bin', '/usr/bin', '/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'].map(dir => join(dir, shell)),
      ...registered.filter(path => basename(path) === shell), ...onPaths(shell, env, 'posix', present),
    ])]
    const seen = new Set()
    return candidates.filter(path => {
      if (!present(path)) return false
      let key = path
      try { key = realpath(path) } catch {}
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).map(path => ({
      id: `posix-${shell}:${createHash('sha256').update(path).digest('hex').slice(0, 12)}`,
      shell, dialect: posixDialect(shell), path, label: `${shell} · ${path}`,
    }))
  })
}

export function detectInstalledShells(platform = process.platform, env = process.env, options = {}) {
  const present = options.present ?? exists
  if (platform === 'win32') {
    const found = windowsPrograms(env, present)
    const wsl = detectWsl(found.wsl, options.run ?? spawnSync, options.report)
    return [
      ...(found.pwsh ? [{ id: 'pwsh7', path: found.pwsh }] : []),
      ...(found.powershell ? [{ id: 'powershell', path: found.powershell }] : []),
      ...detectWindowsBash(env, options),
      ...(wsl.distributions.length ? [{ id: 'wsl', path: found.wsl,
        distributions: wsl.distributions.map(item => item.name), distributionDetails: wsl.distributions, supportsCd: wsl.supportsCd }] : []),
    ]
  }
  return detectPosixShells(env, options)
}

export function resolveSelection(config, platform = process.platform, env = process.env, installedShells) {
  const requested = config.shell ?? 'auto'
  if (requested === 'auto' && config.shellPath) throw new Error('dsh-shell: shellPath requires an explicit shell selection')
  if (requested !== 'wsl' && config.wslDistribution) throw new Error('dsh-shell: wslDistribution requires wsl')
  if (requested === 'wsl' && config.shellPath) throw new Error('dsh-shell: shellPath is not supported for wsl')
  const id = requested === 'auto' ? (platform === 'win32' ? 'native-pwsh' : 'bash') : requested
  const nativeBash = /^(git-bash|msys2|cygwin):/.test(id)
  if (platform === 'win32' && (posixShells.includes(id) || id.startsWith('posix-'))) throw new Error(`dsh-shell: ${id} requires a POSIX host; select wsl on Windows`)
  if (platform !== 'win32' && (nativeBash || ['pwsh7', 'powershell', 'wsl'].includes(id))) throw new Error(`dsh-shell: ${id} requires Windows`)
  if (id === 'native-pwsh') return { id: 'auto', dialect: 'pwsh' }
  if (requested === 'auto') return { id: 'auto', dialect: 'bash', shell: 'bash', environmentShell: environmentShell(env) }
  if (posixShells.includes(id) || id.startsWith('posix-')) {
    const inventory = installedShells ?? detectInstalledShells(platform, env)
    const found = inventory.find(item => item.id === id)
      ?? (posixShells.includes(id) ? inventory.find(item => item.shell === id) : undefined)
    const shell = found?.shell ?? (posixShells.includes(id) ? id : undefined)
    const path = config.shellPath || found?.path
    if (!shell || !path || !executable(path)) throw new Error(`dsh-shell: ${id} executable was not found`)
    if (basename(path) !== shell) throw new Error(`dsh-shell: shellPath must name a ${shell} executable`)
    return { ...found, id: requested, dialect: posixDialect(shell), path, shell, environmentShell: environmentShell(env) }
  }
  if (nativeBash) {
    const found = (installedShells ?? detectInstalledShells(platform, env)).find(item => item.id === id)
    if (!found) throw new Error(`dsh-shell: ${id} installation is unavailable`)
    const path = config.shellPath || found.path
    const identity = config.shellPath ? identifyWindowsBash(path) : found
    if (config.shellPath && (!exists(path) || identity?.runtime !== found.runtime)) {
      throw new Error('dsh-shell: shellPath does not match the selected Bash environment')
    }
    return { ...found, ...identity, path, dialect: 'bash', shell: 'bash' }
  }
  const found = windowsPrograms(env)
  if (id === 'pwsh7' || id === 'powershell') {
    const path = config.shellPath || found[id === 'pwsh7' ? 'pwsh' : 'powershell']
    if (!path || !exists(path)) throw new Error(`dsh-shell: ${id} executable was not found`)
    return { id, dialect: 'pwsh', path }
  }
  if (id === 'wsl') {
    const wsl = (installedShells ?? detectInstalledShells(platform, env)).find(item => item.id === 'wsl')
    const distributions = wsl?.distributions ?? []
    if (!distributions.length) throw new Error('dsh-shell: WSL is unavailable or has no installed distribution')
    const distribution = config.wslDistribution || wsl.distributionDetails?.find(item => item.isDefault)?.name
      || (distributions.length === 1 ? distributions[0] : undefined)
    if (!distribution) throw new Error('dsh-shell: select a WSL distribution explicitly; the default could not be detected')
    if (!distributions.includes(distribution)) throw new Error(`dsh-shell: WSL distribution ${JSON.stringify(distribution)} is not installed`)
    return { id, dialect: 'bash', shell: 'bash', path: wsl.path, distribution,
      wslVersion: wsl.distributionDetails?.find(item => item.name === distribution)?.version ?? null,
      supportsCd: wsl.supportsCd ?? false }
  }
  throw new Error(`dsh-shell: unsupported shell ${JSON.stringify(id)}`)
}
