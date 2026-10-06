set shell := ["bash", "-eu", "-c"]

default:
    @just --list

deps:
    npm ci --ignore-scripts

test:
    npm run test:offline

docs-build:
    npm run docs:build

docs-check:
    npm run docs:check

check:
    npm run check

build-native *args:
    ./scripts/build-native.sh {{args}}

build-host *args:
    ./scripts/build-host.sh {{args}}

verify-native-inputs:
    python3 scripts/release/test_native_input.py

test-release:
    python3 scripts/release/test_native_input.py
    python3 scripts/release/test_release.py

# Explicit Darwin-only synthetic input-admission proof; never a real desktop.
test-observation-gate daemon output_dir:
    FRUITCTL_RUN_NATIVE_SYNTHETIC=1 python3 -I test/fruitctl-observation-gate.py --daemon {{quote(daemon)}} --output-dir {{quote(output_dir)}}

verify-release manifest assets_dir:
    python3 scripts/verify-release.py {{quote(manifest)}} --assets-dir {{quote(assets_dir)}}
