# Forward the user's final login setup as well.
if [[ -r "$__dsh_zsh_user_zdotdir/.zlogin" ]]; then
  ZDOTDIR=$__dsh_zsh_user_zdotdir
  source "$ZDOTDIR/.zlogin"
  __dsh_zsh_user_zdotdir=${ZDOTDIR:-$HOME}
  ZDOTDIR=$__dsh_zsh_wrapper_dir
fi
