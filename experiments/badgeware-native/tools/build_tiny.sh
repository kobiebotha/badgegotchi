#!/bin/sh
set -eu
EXPERIMENT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
POWERBADGE=${POWERBADGE:-"$EXPERIMENT/../../../powerbadge"}
export PYTHONPATH="$EXPERIMENT/vendor/python${PYTHONPATH:+:$PYTHONPATH}"
cd "$EXPERIMENT/tiny"
sh "$POWERBADGE/native/with-toolchain.sh" make V=1
sh "$POWERBADGE/native/with-toolchain.sh" arm-none-eabi-readelf -S -r -A build/badgeprobe.o > ../evidence/tiny-elf.txt
shasum -a 256 badgeprobe.mpy
