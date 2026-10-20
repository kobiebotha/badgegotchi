#!/bin/sh
# Offline archive audit only. Does not open a device or alter firmware.
set -eu
AUDIT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
POWERBADGE_DIR=${POWERBADGE_DIR:-/Users/kobie/projects/powersync/skunkworks/powerbadge}
NATIVE_DIR="$POWERBADGE_DIR/native"
CORE_DIR="$NATIVE_DIR/sqlite-hello/powersync/vendor/powersync-ja-powersync-sqlite-core-0ed9f4e"
python3 "$NATIVE_DIR/sqlite-hello/powersync/fetch.py" --check
export CARGO_TARGET_THUMBV8M_MAIN_NONE_EABI_RUSTFLAGS="-C target-cpu=cortex-m33 -C relocation-model=pic -C panic=abort"
cd "$NATIVE_DIR"
sh "$NATIVE_DIR/with-toolchain.sh" cargo +1.96.0 build \
    --manifest-path "$CORE_DIR/Cargo.toml" \
    --target thumbv8m.main-none-eabi \
    --target-dir "$AUDIT_DIR/build" \
    --package powersync_static --features static \
    --no-default-features --release --locked --offline
python3 "$AUDIT_DIR/inspect_archive.py"
