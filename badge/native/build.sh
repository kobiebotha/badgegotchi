#!/bin/sh
set -eu
cd "$(dirname "$0")"
POWERBADGE=${POWERBADGE:-/Users/kobie/projects/powersync/skunkworks/powerbadge}
export POWERBADGE
export PYTHONPATH="$(pwd)/../../experiments/badgeware-native/vendor/python${PYTHONPATH:+:$PYTHONPATH}"
python3 prepare.py
sh "$POWERBADGE/native/with-toolchain.sh" make "$@"
python3 pin.py
