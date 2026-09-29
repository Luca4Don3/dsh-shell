# ZDOTDIR points to this wrapper; source the user's original zsh environment.
typeset -g __dsh_zsh_wrapper_dir=$ZDOTDIR
typeset -g __dsh_zsh_user_zdotdir=${DSH_ZSH_USER_ZDOTDIR:-$HOME}
unset DSH_ZSH_USER_ZDOTDIR
if [[ -r "$__dsh_zsh_user_zdotdir/.zshenv" ]]; then
  ZDOTDIR=$__dsh_zsh_user_zdotdir
  source "$ZDOTDIR/.zshenv"
  __dsh_zsh_user_zdotdir=${ZDOTDIR:-$HOME}
  ZDOTDIR=$__dsh_zsh_wrapper_dir
fi
