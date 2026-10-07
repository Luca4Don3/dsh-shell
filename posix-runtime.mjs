import { isAbsolute } from 'node:path'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { quoteBash } from './bash-runtime.mjs'

const bashStartup = fileURLToPath(new URL('./bash-startup.bash', import.meta.url))

export const posixShells = ['bash', 'zsh', 'sh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'csh', 'tcsh']

export function posixDialect(shell) {
  if (shell === 'fish') return 'fish'
  if (shell === 'csh' || shell === 'tcsh') return 'csh'
  return shell === 'bash' || shell === 'zsh' ? shell : 'posix'
}

export function posixSyntaxGuidance(shell) {
  const dialect = posixDialect(shell)
  return dialect === 'fish' ? 'Use fish syntax and set/set -gx; do not use Bash export or VAR=value assignments.'
    : dialect === 'csh' ? 'Use C shell syntax and set/setenv; do not use Bash export or VAR=value assignments.'
    : dialect === 'posix' ? 'Use POSIX shell syntax; Bash arrays and other Bash-specific extensions may be unavailable.'
    : `Use ${shell} syntax.`
}

export function quotePosixArgument(value, shell) {
  quoteBash(value) // Reject NUL consistently.
  if (posixDialect(shell) === 'csh') return quoteBash(value).replaceAll('!', '\\!').replaceAll('\n', '\\\n')
  if (shell === 'fish') return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
  return quoteBash(value)
}

export function inheritPosixEnvironment(argv, selection, workdir) {
  const original = selection.environmentShell
  // The target reads its own startup files once when it is already the user's shell.
  if (!original || selection.id !== 'auto' && original.shell === selection.shell
    && (original.path === argv[0] || realpathSync(original.path) === realpathSync(argv[0]))) return argv
  const command = `exec ${argv.map(value => quotePosixArgument(value, original.shell)).join(' ')}`
  return [original.path, ...posixShellArgs(original, command, workdir)]
}

export function posixShellArgs(selection, command, workdir) {
  if (!posixShells.includes(selection.shell)) throw new Error(`dsh-shell: unsupported POSIX shell ${selection.shell}`)
  if (workdir && !isAbsolute(workdir)) throw new Error('dsh-shell: workdir must be an absolute POSIX path')
  if (command !== undefined) quoteBash(command) // Reject NUL before any subprocess is started.
  if (selection.shell === 'bash') {
    const startup = [`. ${quoteBash(bashStartup)}`]
    if (workdir) startup.push(`cd -- ${quoteBash(workdir)} || exit`)
    // The launcher reads no profiles. One interactive shell loads the user's
    // startup configuration before Bash parses the caller's command.
    const launch = `exec "$BASH" --noprofile --rcfile <(printf '%s\\n' ${quoteBash(startup.join('\n'))}) -i${command === undefined ? '' : ' -c "$1" dsh-shell'}`
    return ['--noprofile', '--norc', '-c', launch, 'dsh-shell', ...(command === undefined ? [] : [command])]
  }
  const csh = posixDialect(selection.shell) === 'csh'
  if (command === undefined) return csh ? ['-l'] : ['-l', '-i']
  const setup = []
  if (csh) setup.push('if (-r "$HOME/.login") source "$HOME/.login"')
  if (workdir) {
    setup.push(`cd ${csh ? '' : '-- '}${quotePosixArgument(workdir, selection.shell)}`)
    setup.push(csh ? 'if ($status != 0) exit $status' : selection.shell === 'fish' ? 'or exit' : 'test $? = 0 || exit')
  }
  const script = [...setup, command].join('\n')
  // A multiline csh -c argument resumes at the next line after exit. eval
  // keeps the script in one input context, so early exit also stops setup.
  return [...(csh ? ['-i'] : ['-l', '-i']), '-c', csh ? `eval ${quotePosixArgument(script, selection.shell)}` : script]
}

export function posixPromptSetup(selection, workdir) {
  posixShellArgs(selection, undefined, workdir)
  const dialect = posixDialect(selection.shell)
  let setup
  if (selection.shell === 'bash') setup = [
    'if [ "${PROMPT_COMMAND-}" = "${DSH_SHELL_INJECTED_PROMPT-}" ]; then unset PROMPT_COMMAND; fi',
    'unset DSH_SHELL_INJECTED_PROMPT',
    '__dsh_user_prompt=("${PROMPT_COMMAND[@]}")',
    '__dsh_prompt_status() { return "$1"; }',
    '__dsh_prompt() { local status=$? hook; for hook in "${__dsh_user_prompt[@]}"; do __dsh_prompt_status "$status"; eval "$hook"; done; printf "\\033]133;D;%s\\007" "$status"; PS1="dsh> "; }',
    'PROMPT_COMMAND=__dsh_prompt; PS1="dsh> "',
  ]
  else if (selection.shell === 'zsh') setup = [
    'if (( $+functions[precmd] )); then functions[__dsh_zsh_user_precmd]=$functions[precmd]; fi',
    '__dsh_zsh_status() { return "$1"; }',
    'precmd() { typeset -g __dsh_zsh_command_status=$?; if (( $+functions[__dsh_zsh_user_precmd] )); then __dsh_zsh_status "$__dsh_zsh_command_status"; __dsh_zsh_user_precmd; fi; }',
    '__dsh_zsh_prompt() { printf "\\033]133;D;%d\\007dsh> " "${__dsh_zsh_command_status:-0}"; }',
    'setopt PROMPT_SUBST; unsetopt PROMPT_SP; PS1=\'$(__dsh_zsh_prompt)\'; RPS1=\'\'',
  ]
  else if (dialect === 'csh') setup = [
    'set prompt = "`printf \'\\033]133;D;\'`%?`printf \'\\007\'`dsh> "',
    'set __dsh_csh_end = ""',
    'alias __dsh_user_precmd "`alias precmd`"',
    `alias precmd ${quotePosixArgument([
      'set __dsh_csh_status=$status',
      'if ("$__dsh_csh_end" != "") printf \'%s%s\\n\' "$__dsh_csh_end" "$__dsh_csh_status"',
      'set __dsh_csh_end = ""',
      'set prompt = "`printf \'\\033]133;D;%s\\007\' "$__dsh_csh_status"`dsh> "',
      'set status = $__dsh_csh_status',
      '__dsh_user_precmd',
    ].join('; '), selection.shell)}`,
  ]
  else if (dialect === 'fish') setup = [
    'if functions -q fish_prompt; functions -c fish_prompt __dsh_user_fish_prompt; end',
    'function __dsh_fish_status; return $argv[1]; end',
    'function fish_prompt; set -l command_status $status; if functions -q __dsh_user_fish_prompt; __dsh_fish_status $command_status; __dsh_user_fish_prompt >/dev/null; end; printf "\\033]133;D;%d\\007dsh> " $command_status; end',
    'functions -e fish_right_prompt',
  ]
  else setup = ['PS1=\'$(printf "\\033]133;D;%d\\007" "$?")dsh> \'']
  // Login files may change cwd; restore the terminal's host-selected directory.
  if (workdir) {
    setup.push(`cd ${dialect === 'csh' ? '' : '-- '}${quotePosixArgument(workdir, selection.shell)}`)
    setup.push(dialect === 'csh' ? 'if ($status != 0) exit $status' : dialect === 'fish' ? 'or exit' : 'test $? = 0 || exit')
  }
  return setup.join('; ')
}

export function initializePosixSession(session, selection, workdir) {
  const initialize = session.initialize.bind(session)
  const setup = posixPromptSetup(selection, workdir)
  session.initialize = async signal => {
    const startSend = session.startSend
    // DSH owns readiness, timeout, cancellation and failed-start cleanup.
    session.startSend = request => startSend.call(session, { ...request, text: setup, submit: true })
    try {
      await initialize(signal)
    } finally {
      session.startSend = startSend
    }
  }
  return session
}
