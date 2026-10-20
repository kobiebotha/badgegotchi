"""Apply the reviewed source transformation manifest without changing evidence."""
import hashlib
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EXPERIMENT = ROOT.parents[1] / "experiments/badgeware-native"
POWERBADGE = Path(os.environ.get("POWERBADGE", "/Users/kobie/projects/powersync/skunkworks/powerbadge"))
SOURCE = POWERBADGE / "native/sqlite-hello/vendor/sqlite-littlefs-vfs/vendor/sqlite/sqlite3.c"
CORE = EXPERIMENT / "powersync-audit/build/thumbv8m.main-none-eabi/release/libpowersync.a"
CORE_SHA256 = "d5b146ff16d488beb8038a43d32754c4c7e2a1fcfb1543033bf13c6a52b20e60"
if hashlib.sha256(CORE.read_bytes()).hexdigest() != CORE_SHA256:
    raise ValueError("PowerSync archive differs from the qualified softfp/PIC build")
manifest = json.loads((EXPERIMENT / "sqlite-audit/source-adaptations.json").read_text())
source = SOURCE.read_bytes()
assert hashlib.sha256(source).hexdigest() == manifest["source_sha256"]
text = source.decode()
for change in manifest["changes"]:
    assert text.count(change["before"]) == change["count"]
    text = text.replace(change["before"], change["after"])
assert hashlib.sha256(text.encode()).hexdigest() == manifest["adapted_sha256"]
(ROOT / "sqlite3-adapted.inc").write_text(text)
