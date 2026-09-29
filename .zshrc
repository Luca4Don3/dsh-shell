# Load the user's interactive setup before installing DSH's prompt marker.
if [[ -r "$__dsh_zsh_user_zdotdir/.zshrc" ]]; then
  ZDOTDIR=$__dsh_zsh_user_zdotdir
  source "$ZDOTDIR/.zshrc"
  __dsh_zsh_user_zdotdir=${ZDOTDIR:-$HOME}
  ZDOTDIR=$__dsh_zsh_wrapper_dir
fi

unsetopt PROMPT_SP
if (( $+functions[precmd] )); then
  functions[__dsh_zsh_user_precmd]=$functions[precmd]
fi
precmd() {
  __dsh_zsh_command_status=$?
  if (( $+functions[__dsh_zsh_user_precmd] )); then
    __dsh_zsh_user_precmd
  fi
}
__dsh_zsh_prompt() {
  printf '\033]133;D;%d\007' "$__dsh_zsh_command_status"
  PS1='dsh> '
}
typeset -ga precmd_functions
precmd_functions+=(__dsh_zsh_prompt)
