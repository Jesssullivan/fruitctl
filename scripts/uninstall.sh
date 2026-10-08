#!/bin/sh
set -eu
install_root='' root_selected='false' needs_root='false'
for argument in "$@"; do
  if [ "$needs_root" = 'true' ]; then
    install_root=$argument; root_selected='true'; needs_root='false'
    continue
  fi
  case "$argument" in
    --install-root) needs_root='true';;
    --install-root=*) install_root=${argument#--install-root=}; root_selected='true';;
    --) break;;
  esac
done
if [ "$needs_root" = 'true' ]; then printf '%s\n' 'fruitctl: Missing value for --install-root' >&2; exit 1; fi
if [ "$root_selected" = 'true' ]; then
  case "$install_root" in /*) ;; *) printf '%s\n' 'fruitctl: --install-root must be a nonempty absolute directory' >&2; exit 1;; esac
fi
if [ -n "${FRUITCTL_EXECUTABLE:-}" ]; then executable=$FRUITCTL_EXECUTABLE
elif [ "$root_selected" = 'true' ]; then executable="$install_root/bin/fruitctl"
else executable="$HOME/.local/bin/fruitctl"; fi
[ -x "$executable" ] || { printf '%s\n' 'fruitctl: installed launcher missing; use the pinned release CLI to inspect its receipt' >&2; exit 1; }
exec "$executable" uninstall "$@"
