import { isAbsolute } from 'node:path'
import { realpathSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
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

// Keep quoted words below canonical PTY line limits, including long paths.
function quotePosixInput(value) {
  return Array.from(value).reduce((parts, character) => {
    if (parts.at(-1).length >= 32) parts.push('')
    parts[parts.length - 1] += character
    return parts
  }, ['']).map(quoteBash).join('\\\n')
}

function bashPromptSetup(reportCompletion = false) {
  return [
    // Declare the prompt variables before any hook runs, and reference them with
    // a default: a user shell may enable `set -u`, where an unset reference
    // aborts the hook and the prompt never reports completion.
    '__dsh_pending_end=""',
    'if [ "${PROMPT_COMMAND-}" = "${DSH_SHELL_INJECTED_PROMPT-}" ]; then unset PROMPT_COMMAND; fi',
    'unset DSH_SHELL_INJECTED_PROMPT',
    '__dsh_user_prompt=("${PROMPT_COMMAND[@]:-}")',
    '__dsh_prompt_status() { return "$1"; }',
    '__dsh_prompt() { local status=$? hook; '
      + (reportCompletion ? 'if [ -n "${__dsh_pending_end:-}" ]; then printf "%s%s\\n" "${__dsh_pending_end:-}" "$status"; __dsh_pending_end=""; fi; ' : '')
      + 'for hook in "${__dsh_user_prompt[@]:-}"; do __dsh_prompt_status "$status"; eval "$hook"; done; printf "\\033]133;D;%s\\007" "$status"; PS1="dsh> "; }',
    'PROMPT_COMMAND=__dsh_prompt; PS1="dsh> "',
  ]
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
  if (selection.shell === 'bash') setup = bashPromptSetup(true)
  else if (selection.shell === 'zsh') setup = [
    '__dsh_pending_end=""',
    'if (( $+functions[precmd] )); then functions[__dsh_zsh_user_precmd]=$functions[precmd]; fi',
    '__dsh_zsh_status() { return "$1"; }',
    // Dispatch the live list once, then temporarily hide it from zsh's native
    // dispatcher. PS1 restores the array in the parent shell before input, so
    // add-zsh-hook can still add/remove hooks, including from another hook.
    [
      'precmd() { local command_status=$? hook hook_status=0',
      'if [[ -n $__dsh_pending_end ]]; then printf "%s%s\\n" "$__dsh_pending_end" "$command_status"; __dsh_pending_end=""; fi',
      'if (( $+functions[__dsh_zsh_user_precmd] )); then __dsh_zsh_status "$command_status"; __dsh_zsh_user_precmd || hook_status=$?; fi',
      'if (( hook_status == 0 && $+precmd_functions )); then for hook in "${precmd_functions[@]}"; do if (( $+functions[$hook] )); then __dsh_zsh_status "$command_status"; "$hook" || { hook_status=$?; break; }; fi; done; fi',
      '__dsh_zsh_next_hooks=(); if (( $+precmd_functions )); then __dsh_zsh_next_hooks=("${precmd_functions[@]}"); fi; precmd_functions=()',
      'printf "\\033]133;D;%d\\007" "$command_status"; setopt PROMPT_SUBST; unsetopt PROMPT_SP',
      'PS1=\'${${(@A)precmd_functions::=${__dsh_zsh_next_hooks[@]}}:+}dsh> \'; RPS1=""; return "$hook_status"; }',
    ].join(';\\\n'),
    'unsetopt PROMPT_SP; PS1="dsh> "; RPS1=""',
  ]
  else if (dialect === 'csh') setup = [
    'set prompt = "`printf \'\\033]133;D;\'`%?`printf \'\\007\'`dsh> "',
    'set __dsh_csh_end = ""',
    'alias __dsh_user_precmd "`alias precmd`"',
    `alias precmd ${quotePosixArgument([
      'set __dsh_csh_status=$status',
      'if ("$__dsh_csh_end" != "") printf \'%s%s\\n\' "$__dsh_csh_end" "$__dsh_csh_status"',
      'set __dsh_csh_end = ""',
      'set status = $__dsh_csh_status',
      '__dsh_user_precmd',
      'set prompt = "`printf \'\\033]133;D;%s\\007\' "$__dsh_csh_status"`dsh> "',
    ].join('; '), selection.shell)}`,
  ]
  else if (dialect === 'fish') setup = [
    'if functions -q fish_prompt; functions -c fish_prompt __dsh_user_fish_prompt; end',
    'function __dsh_fish_status; return $argv[1]; end',
    'function fish_prompt; set -l command_status $status; if functions -q __dsh_user_fish_prompt; __dsh_fish_status $command_status; __dsh_user_fish_prompt >/dev/null; end; printf "\\033]133;D;%d\\007dsh> " $command_status; end',
    'functions -e fish_right_prompt',
  ]
  else setup = [
    '__dsh_pending_end=; __dsh_prompt_done=',
    '__dsh_prompt() { __dsh_status=$?; if [ "${__dsh_prompt_done+x}" != x ] && [ -n "${__dsh_pending_end:-}" ]; then printf "%s%s\\n" "$__dsh_pending_end" "$__dsh_status"; fi; printf "\\033]133;D;%d\\007" "$__dsh_status"; }',
    // Command substitution cannot clear parent-shell state. The assignment
    // expansion marks this frame reported, so subsequent prompts cannot repeat it.
    'PS1=\'$(__dsh_prompt)${__dsh_prompt_done=}dsh> \'',
  ]
  // macOS sh is Bash: its PROMPT_COMMAND runs before PS1 and can replace it.
  // Use the Bash hook dispatcher there, while keeping other sh implementations
  // free of Bash-only syntax until the runtime check succeeds.
  if (selection.shell === 'sh') setup.push(`if [ -n "\${BASH_VERSION-}" ]; then eval ${quoteBash(bashPromptSetup(true).join('\n'))}; fi`)
  // Login files may change cwd; restore the terminal's host-selected directory.
  if (workdir) {
    setup.push(`cd ${dialect === 'csh' ? '' : '-- '}${dialect === 'posix' ? quotePosixInput(workdir) : quotePosixArgument(workdir, selection.shell)}`)
    setup.push(dialect === 'csh' ? 'if ($status != 0) exit $status' : dialect === 'fish' ? 'or exit' : 'test $? = 0 || exit')
  }
  return setup.join(dialect === 'posix' ? ';\\\n' : '; ')
}

export function initializePosixSession(session, selection, workdir) {
  const initialize = session.initialize.bind(session)
  const setup = posixPromptSetup(selection, workdir)
  session.initialize = async signal => {
    const nonce = randomUUID()
    const marker = `__DSH_SHELL_READY_${nonce}__`
    // Keep the complete marker out of the input: a terminal echo is not an
    // acknowledgement that setup ran (startup files may consume it via read).
    const acknowledge = `printf '\\n%s%s\\n' '__DSH_SHELL_READY_' '${nonce}__'`
    const startSend = session.startSend
    let completion
    // DSH owns readiness, timeout, cancellation and failed-start cleanup.
    // Bash used as sh repaints long input through readline, which can corrupt the
    // compound command before it completes and leave the shell waiting on PS2.
    // Turn the prompt editor off before the setup that must arrive intact.
    const prefix = selection.shell === 'sh' ? 'set +o emacs 2>/dev/null; set +o vi 2>/dev/null; ' : ''
    session.startSend = request => {
      // One compound command keeps the acknowledgement coupled to the setup.
      // If startup read consumes the opening line, the unmatched closing brace
      // prevents the remaining lines from claiming successful initialization.
      const text = posixDialect(selection.shell) === 'posix' ? `${prefix}{ ${setup}; ${acknowledge}; }` : `${setup}; ${acknowledge}`
      const operation = startSend.call(session, { ...request, text, submit: true })
      completion = operation.done
      return operation
    }
    try {
      await initialize(signal)
      const result = await completion
      if (!result?.viewport?.replaceAll('\r\n', '\n').includes(`\n${marker}\n`)) {
        throw new Error('dsh-shell: shell initialization was not acknowledged; startup configuration may have consumed its input')
      }
    } finally {
      session.startSend = startSend
    }
  }
  return session
}
