import { win32 } from 'node:path'

export function quoteBash(value) {
  if (value.includes('\0')) throw new TypeError('shell command cannot contain NUL')
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function isWindowsBash(selection) {
  return selection.id === 'wsl' || ['git-bash', 'msys2', 'cygwin'].includes(selection.runtime)
}

export function assertWindowsWorkdir(workdir) {
  if (!workdir || !win32.isAbsolute(workdir) || !/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(workdir)) {
    throw new Error('dsh-shell: workdir must be an absolute Windows path (C:\\... or \\\\server\\share); use Linux/POSIX paths inside the Bash command')
  }
  if (workdir.includes('\0')) throw new TypeError('workdir cannot contain NUL')
}

export function assertBashPolicy(selection, policy) {
  if (selection.id === 'wsl' && policy?.mode !== 'danger-full-access') {
    throw new Error('dsh-shell: WSL cannot be confined by the DSH Windows sandbox; use danger-full-access explicitly')
  }
}

export function runtimeEnvironment(selection, env = {}, hostEnv = {}) {
  if (selection.id !== 'wsl') return {
    ...(selection.runtime === 'git-bash' && selection.msystem ? { MSYSTEM: selection.msystem } : {}),
    ...env,
    CHERE_INVOKING: '1',
  }
  // Windows keys are case-insensitive. Explicit DSH/task values win over the
  // canonical scrubbed parent; never copy process.env past DSH's env filter.
  const merged = {}
  const keys = new Map()
  for (const layer of [hostEnv, env]) for (const [key, value] of Object.entries(layer)) {
    const upper = key.toUpperCase()
    const previous = keys.get(upper)
    if (previous) delete merged[previous]
    keys.set(upper, key)
    merged[key] = value
  }
  const path = merged[keys.get('PATH')]
  const helper = 'DSH_SHELL_WINDOWS_PATH'
  merged[helper] = path ?? ''
  const entries = []
  const forwarded = new Set()
  for (const entry of (merged[keys.get('WSLENV')] ?? '').split(':').filter(Boolean)) {
    const [key, flags] = entry.split('/')
    const upper = key.toUpperCase()
    if (['PATH', 'HOME', 'WSLENV', helper].includes(upper) || forwarded.has(upper)) continue
    const actual = keys.get(upper) ?? key
    entries.push(`${actual}${flags === undefined ? '' : `/${flags}`}`)
    forwarded.add(upper)
  }
  for (const [key, value] of Object.entries(merged)) {
    const upper = key.toUpperCase()
    if (value === undefined || ['PATH', 'HOME', 'WSLENV', helper].includes(upper) || forwarded.has(upper)) continue
    if (!/^[^:/=\0]+$/.test(key)) throw new Error(`dsh-shell: environment name ${JSON.stringify(key)} cannot be forwarded through WSLENV`)
    entries.push(key)
    forwarded.add(upper)
  }
  entries.push(`${helper}/pl`)
  if (keys.has('WSLENV')) delete merged[keys.get('WSLENV')]
  return { ...merged, WSLENV: entries.join(':') }
}

function executableArgs(selection, args, workdir) {
  return selection.id === 'wsl'
    ? [selection.path, '--distribution', selection.distribution,
      ...(selection.supportsCd && workdir ? ['--cd', workdir] : []), '--exec', '/bin/bash', ...args]
    : [selection.path, ...args]
}

export const bashProbeCommand = 'printf "__DSH_BASH_RUNTIME__%s\\n" "$BASH_VERSION"; printf "__DSH_BASH_OS__"; uname -s'

export function bashProbeArgv(selection) {
  return executableArgs(selection, ['--noprofile', '--norc', '-c', bashProbeCommand])
}

export function validateBashProbe(selection, result) {
  if (result.aborted) throw new Error('dsh-shell: Bash capability check was cancelled')
  if (result.timedOut) throw new Error('dsh-shell: Bash capability check timed out; the distribution may still be starting')
  const version = result.stdout?.text.match(/__DSH_BASH_RUNTIME__(\d+\.\d+[^\r\n]*)/)?.[1]
  const os = result.stdout?.text.match(/__DSH_BASH_OS__([^\r\n]+)/)?.[1]
  const expected = selection.id === 'wsl' ? /^Linux$/ : selection.runtime === 'cygwin' ? /^CYGWIN/ : /^(?:MSYS|MINGW|CLANG(?:64|ARM64))/
  if (result.exitCode !== 0 || !version || !os || !expected.test(os)) {
    throw new Error(`dsh-shell: ${selection.distribution ?? selection.runtime} did not pass its Bash capability check; /bin/bash (WSL), Bash and uname must be available. ${result.stderr?.text.trim().slice(0, 500) ?? ''}`.trim())
  }
  return { version, os }
}

export function bashRuntimeArgv(selection, workdir, command, persistent = false) {
  assertWindowsWorkdir(workdir)
  const converter = selection.id === 'wsl' ? 'wslpath' : 'cygpath'
  const startup = [
    ...(persistent ? [
      'if [ "${PROMPT_COMMAND-}" = "${DSH_SHELL_INJECTED_PROMPT-}" ]; then unset PROMPT_COMMAND; fi',
      'unset DSH_SHELL_INJECTED_PROMPT',
    ] : []),
    'if [ -r "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi',
    ...(selection.id === 'wsl' ? [
      'IFS=: read -r -a __dsh_windows_paths <<< "${DSH_SHELL_WINDOWS_PATH-}"',
      'for __dsh_path in "${__dsh_windows_paths[@]}"; do if [ -n "$__dsh_path" ]; then case ":${PATH-}:" in *":$__dsh_path:"*) ;; *) PATH="${PATH:+$PATH:}$__dsh_path" ;; esac; fi; done',
      'export PATH; unset DSH_SHELL_WINDOWS_PATH __dsh_windows_paths __dsh_path',
    ] : []),
    `__dsh_cwd=$(${converter} -u ${quoteBash(workdir)}) || exit`,
    'cd -- "$__dsh_cwd" || exit',
  ]
  if (persistent) startup.push(
    '__dsh_user_prompt=("${PROMPT_COMMAND[@]}")',
    '__dsh_prompt_status() { return "$1"; }',
    '__dsh_prompt() { local status=$? hook; for hook in "${__dsh_user_prompt[@]}"; do __dsh_prompt_status "$status"; eval "$hook"; done; printf "\\033]133;D;%s\\007" "$status"; PS1="dsh> "; }',
    'PROMPT_COMMAND=__dsh_prompt; PS1="dsh> "',
  )
  // The outer login shell reads profiles. The inner interactive shell reads the
  // user's bashrc through an inline rcfile, then restores the requested cwd.
  // No startup file is written into the user's profile or Linux filesystem.
  const setup = `exec "$BASH" --noprofile --rcfile <(printf '%s\\n' ${quoteBash(startup.join('\n'))}) -i${persistent ? '' : ' -c "$1" dsh-shell'}`
  return executableArgs(selection, ['-lc', setup, 'dsh-shell', ...(persistent ? [] : [command])], workdir)
}
