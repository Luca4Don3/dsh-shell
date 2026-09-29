# Preserve the user's login environment before the interactive setup runs.
if [[ -r "$__dsh_zsh_user_zdotdir/.zprofile" ]]; then
  ZDOTDIR=$__dsh_zsh_user_zdotdir
  source "$ZDOTDIR/.zprofile"
  __dsh_zsh_user_zdotdir=${ZDOTDIR:-$HOME}
  ZDOTDIR=$__dsh_zsh_wrapper_dir
fi
