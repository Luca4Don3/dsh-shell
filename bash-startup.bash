# Keep login configuration in the interactive shell, preserving unexported
# variables, aliases and functions. A user profile owns whether to load bashrc;
# only homes without a login profile get a direct bashrc fallback.
if [[ -r /etc/profile ]]; then . /etc/profile; fi
__dsh_profile_loaded=
for __dsh_profile in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
    if [[ -r $__dsh_profile ]]; then
        . "$__dsh_profile"
        __dsh_profile_loaded=1
        break
    fi
done
if [[ -z $__dsh_profile_loaded && -r "$HOME/.bashrc" ]]; then . "$HOME/.bashrc"; fi
unset __dsh_profile __dsh_profile_loaded
