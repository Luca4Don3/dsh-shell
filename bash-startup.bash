# Keep login configuration in the interactive shell, preserving unexported
# variables, aliases and functions. A user profile owns whether to load bashrc;
# only homes without a login profile get a direct bashrc fallback.
if [[ -r /etc/profile ]]; then . /etc/profile; fi
for __dsh_profile in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
    if [[ -r $__dsh_profile ]]; then
        . "$__dsh_profile"
        unset __dsh_profile
        return
    fi
done
unset __dsh_profile
if [[ -r "$HOME/.bashrc" ]]; then . "$HOME/.bashrc"; fi
