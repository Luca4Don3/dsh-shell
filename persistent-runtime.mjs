import { posixDialect, quotePosixArgument } from './posix-runtime.mjs'

// DSH 0.2.0-rc.1's private frame is checked in full before translation. Keep
// its markers so the original tool still owns output, deadlines and cleanup.
const string = String.raw`\$'((?:[^'\\]|\\[\\'rn])*)'`
const frame = new RegExp(String.raw`^printf '%s\\n' ${string}; eval -- ${string}; __dsh_persistent_bash_status=\$\?; printf '%s%s\\n' ${string} "\$__dsh_persistent_bash_status"$`)
const decode = value => value.replace(/\\([\\'rn])/g, (_match, escaped) => ({ r: '\r', n: '\n' }[escaped] ?? escaped))

// Leave room for CR reconstruction and two quoting layers within the PTY's
// canonical input limit, without splitting a Unicode code point.
function chunks(value) {
  const result = ['']
  for (const character of value) {
    if (result.at(-1).length >= 16) result.push('')
    result[result.length - 1] += character
  }
  return result
}

export function adaptPersistentCommand(text, shell) {
  // Bash used as sh can lose queued continuation lines while readline toggles
  // terminal modes. Persistent frames need no prompt editor; keep canonical
  // input enabled for programs run by the command itself.
  if (text === 'stty -echo' && shell === 'sh') {
    return 'stty -echo && { if [ -n "${BASH_VERSION-}" ]; then set +o emacs; set +o vi; fi; }'
  }
  if (text === '' || text === 'stty -echo') return text
  const match = frame.exec(text)
  if (!match) throw new Error('dsh-shell: unsupported DSH persistent command frame; check the DSH version')
  const [start, command, end] = match.slice(1).map(decode)
  const nonce = /^__DSH_PERSISTENT_BASH_START_([\da-f-]+)__$/.exec(start)?.[1]
  if (!nonce || end !== `__DSH_PERSISTENT_BASH_END_${nonce}:`) {
    throw new Error('dsh-shell: invalid DSH persistent command markers')
  }
  const dialect = posixDialect(shell)
  quotePosixArgument(command, shell) // Reject NUL before choosing a transport encoding.
  // A literal CR is treated as Enter by the PTY. Reconstruct it inside the
  // shell instead, after terminal input processing, including nested evals.
  const carriageReturn = dialect === 'csh' ? '"`printf \'\\r\'`"'
    : dialect === 'fish' ? '(printf \'\\r\')' : '"$(printf \'\\r\')"'
  const quote = value => {
    if (dialect === 'zsh') return `$'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\r', '\\r').replaceAll('\n', '\\n')}'`
    const quoteChunk = chunk => chunk.split('\r').map(part => quotePosixArgument(part, shell)).join(carriageReturn)
    return dialect === 'posix' ? chunks(value).map(quoteChunk).join('\\\n') : quoteChunk(value)
  }
  if (dialect === 'csh') {
    // C shell treats a continuation between quoted words as a space. Build
    // the command inside one eval input context instead, using short lines.
    return `eval ${quote([
      `set __dsh_csh_end = ${quote(end)}`,
      `printf '%s\\n' ${quote(start)}`,
      'set __dsh_code = ""',
      ...chunks(command).map(chunk => `set __dsh_code = $__dsh_code:q${quote(chunk)}`),
      'eval $__dsh_code:q',
    ].join('\n'))}`
  }
  if (['posix', 'zsh', 'bash'].includes(dialect)) {
    // Expansion/syntax errors can unwind eval before any trailing statement.
    // Report completion at the next prompt, in the original shell process.
    return [
      `__dsh_pending_end=${quote(end)}`,
      ...(dialect === 'posix' ? ['unset __dsh_prompt_done'] : []),
      `printf '%s\\n' ${quote(start)}`,
      `eval ${quote(command)}`,
    ].join('; ')
  }
  const status = dialect === 'fish' ? 'set -g __dsh_persistent_status $status' : '__dsh_persistent_status=$?'
  const script = [
    `printf '%s\\n' ${quote(start)}`,
    `eval ${quote(command)}`,
    status,
    `printf '%s%s\\n' ${quote(end)} "$__dsh_persistent_status"`,
  ].join('\n')
  // One input context prevents prompt hooks/markers between frame statements.
  return `eval ${quote(script)}`
}

export function withPersistentTransport(ctx, shell) {
  const terminals = new Proxy(ctx.terminals, { get(target, key) {
    if (key === 'startSend') return (owner, id, request) => target.startSend(owner, id,
      { ...request, text: adaptPersistentCommand(request.text, shell) })
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  return new Proxy(ctx, { get(target, key) {
    if (key === 'terminals') return terminals
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
}
