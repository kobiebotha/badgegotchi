#!/bin/sh
set -eu
cd "$(dirname "$0")"
POWERBADGE=${POWERBADGE:-/Users/kobie/projects/powersync/skunkworks/powerbadge}
export PYTHONPATH="$(pwd)/../vendor/python${PYTHONPATH:+:$PYTHONPATH}"
python3 adapt_sqlite.py
exec sh "$POWERBADGE/native/with-toolchain.sh" make "$@"
