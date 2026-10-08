import { posixDialect, quotePosixArgument } from './posix-runtime.mjs'

// DSH 0.2.0-rc.1's private frame is checked in full before translation. Keep
// its markers so the original tool still owns output, deadlines and cleanup.
const string = String.raw`\$'((?:[^'\\]|\\[\\'rn])*)'`
const frame = new RegExp(String.raw`^printf '%s\\n' ${string}; eval -- ${string}; __dsh_persistent_bash_status=\$\?; printf '%s%s\\n' ${string} "\$__dsh_persistent_bash_status"$`)
const decode = value => value.replace(/\\([\\'rn])/g, (_match, escaped) => ({ r: '\r', n: '\n' }[escaped] ?? escaped))

export function adaptPersistentCommand(text, shell) {
  if (text === '' || text === 'stty -echo') return text
  const match = frame.exec(text)
  if (!match) throw new Error('dsh-shell: unsupported DSH persistent command frame; check the DSH version')
  const [start, command, end] = match.slice(1).map(decode)
  const nonce = /^__DSH_PERSISTENT_BASH_START_([\da-f-]+)__$/.exec(start)?.[1]
  if (!nonce || end !== `__DSH_PERSISTENT_BASH_END_${nonce}:`) {
    throw new Error('dsh-shell: invalid DSH persistent command markers')
  }
  const dialect = posixDialect(shell)
  // A literal CR is treated as Enter by the PTY. Reconstruct it inside the
  // shell instead, after terminal input processing, including nested evals.
  const carriageReturn = dialect === 'csh' ? '"`printf \'\\r\'`"'
    : dialect === 'fish' ? '(printf \'\\r\')' : '"$(printf \'\\r\')"'
  const quote = value => value.split('\r').map(part => quotePosixArgument(part, shell)).join(carriageReturn)
  if (dialect === 'csh') {
    // Expansion errors abort the entire eval, including any trailing status
    // capture. The terminal's precmd hook reports the status once on return
    // to the prompt, including failed expansions, without losing shell state.
    return `eval ${quote([
      `set __dsh_csh_end = ${quote(end)}`,
      `printf '%s\\n' ${quote(start)}`,
      `eval ${quote(command)}`,
    ].join('\n'))}`
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
