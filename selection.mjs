import { lstatSync } from 'node:fs'
import { basename, delimiter, join, win32 } from 'node:path'
import { spawnSync } from 'node:child_process'

function exists(path) {
  try {
    const info = lstatSync(path)
    return info.isFile() || info.isSymbolicLink()
  } catch {
    return false
  }
}

function onPath(command, env, platform) {
  const separator = platform === 'win32' ? ';' : delimiter
  const pathJoin = platform === 'win32' ? win32.join : join
  const names = platform === 'win32' && !/\.exe$/i.test(command) ? [`${command}.exe`, command] : [command]
  for (const entry of (env.PATH ?? env.Path ?? '').split(separator)) {
    const directory = entry.trim().replace(/^"|"$/g, '')
    if (!directory) continue
    for (const name of names) {
      const candidate = pathJoin(directory, name)
      if (exists(candidate)) return candidate
    }
  }
}

function windowsPrograms(env) {
  const systemRoot = env.SystemRoot ?? 'C:\\Windows'
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
  const pwsh = [win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe'), onPath('pwsh', env, 'win32')].find(path => path && exists(path))
  const powershell = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const wsl = [win32.join(systemRoot, 'System32', 'wsl.exe'), onPath('wsl', env, 'win32')].find(path => path && exists(path))
  return { pwsh, powershell: exists(powershell) ? powershell : undefined, wsl }
}

export function detectWslDistributions(wsl, run = spawnSync) {
  if (!wsl) return []
  const result = run(wsl, ['--list', '--quiet'], { encoding: 'buffer', timeout: 3000, windowsHide: true })
  if (result.error || result.status !== 0) return []
  const bytes = result.stdout ?? Buffer.alloc(0)
  const output = bytes.includes(0) ? bytes.toString('utf16le') : bytes.toString('utf8')
  return [...new Set(output.replaceAll('\u0000', '').split(/\r?\n/).map(value => value.trim()).filter(Boolean))]
}

export function detectInstalledShells(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const found = windowsPrograms(env)
    const distributions = detectWslDistributions(found.wsl)
    return [
      ...(found.pwsh ? [{ id: 'pwsh7', path: found.pwsh }] : []),
      ...(found.powershell ? [{ id: 'powershell', path: found.powershell }] : []),
      ...(distributions.length ? [{ id: 'wsl', path: found.wsl, distributions }] : []),
    ]
  }
  return ['bash', 'zsh'].flatMap(id => {
    const path = [`/bin/${id}`, onPath(id, env, platform)].find(candidate => candidate && exists(candidate))
    return path ? [{ id, path }] : []
  })
}

export function resolveSelection(config, platform = process.platform, env = process.env) {
  const requested = config.shell ?? 'auto'
  if (requested === 'auto' && config.shellPath) throw new Error('dsh-shell: shellPath requires an explicit shell selection')
  if (requested !== 'wsl' && config.wslDistribution) throw new Error('dsh-shell: wslDistribution requires wsl')
  if (requested === 'wsl' && config.shellPath) throw new Error('dsh-shell: shellPath is not supported for wsl')
  const id = requested === 'auto' ? (platform === 'win32' ? 'native-pwsh' : 'bash') : requested
  if (platform === 'win32' && ['bash', 'zsh'].includes(id)) throw new Error(`dsh-shell: ${id} requires a POSIX host; select wsl on Windows`)
  if (platform !== 'win32' && ['pwsh7', 'powershell', 'wsl'].includes(id)) throw new Error(`dsh-shell: ${id} requires Windows`)
  if (id === 'native-pwsh') return { id: 'auto', dialect: 'pwsh' }
  if (['bash', 'zsh'].includes(id)) {
    const path = config.shellPath || detectInstalledShells(platform, env).find(item => item.id === id)?.path
    if (!path || !exists(path)) throw new Error(`dsh-shell: ${id} executable was not found`)
    if (basename(path) !== id) throw new Error(`dsh-shell: shellPath must name a ${id} executable`)
    return { id: requested, dialect: 'bash', path, shell: id }
  }
  const found = windowsPrograms(env)
  if (id === 'pwsh7' || id === 'powershell') {
    const path = config.shellPath || found[id === 'pwsh7' ? 'pwsh' : 'powershell']
    if (!path || !exists(path)) throw new Error(`dsh-shell: ${id} executable was not found`)
    return { id, dialect: 'pwsh', path }
  }
  if (id === 'wsl') {
    const distributions = detectWslDistributions(found.wsl)
    if (!distributions.length) throw new Error('dsh-shell: WSL has no installed distribution')
    const distribution = config.wslDistribution || undefined
    if (distribution && !distributions.includes(distribution)) throw new Error(`dsh-shell: WSL distribution ${JSON.stringify(distribution)} is not installed`)
    return { id, dialect: 'bash', path: found.wsl, distribution }
  }
  throw new Error(`dsh-shell: unsupported shell ${JSON.stringify(id)}`)
}
