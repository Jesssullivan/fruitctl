#!/bin/sh
set -eu
executable="${FRUITCTL_EXECUTABLE:-$HOME/.local/bin/fruitctl}"
[ -x "$executable" ] || { printf '%s\n' 'fruitctl: installed launcher missing; use the pinned release CLI to inspect its receipt' >&2; exit 1; }
exec "$executable" uninstall "$@"
