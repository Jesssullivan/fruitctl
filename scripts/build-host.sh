#!/usr/bin/env bash
set -euo pipefail

# Keep the optional app on the same receipt-producing, bounded Darwin build
# rail as the native client. This selects only the app and its offline tests;
# it never launches the desktop UI or asks for screen-recording permission.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$script_dir/build-native.sh" \
  --build-scheme FruitctlHost \
  --test-scheme FruitctlHostTests \
  "$@"
