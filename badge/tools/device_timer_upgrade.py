"""One-time alpha.1 -> alpha.2 qualification, preserving the original snapshot.

Back up the existing state.sqlite on the host first. This fixture requires a
paused v1 snapshot and prints it before migrating. It then stores a running
copy for a reset/elapsed-time test. Restore using device_timer_restore.py with
the exact printed original and candidate JSON prepended as fixture globals.
"""
import json
import machine
import os
import sys

sys.path.insert(0, "/system/apps/badgegotchi")
from badgegotchi_runtime import load_native
from badgegotchi_state import rtc_seconds
from badgegotchi_storage import BadgeVFS, Store, ROOT, DATABASE

watchdog = machine.WDT(timeout=16000)
native = load_native(watchdog.feed)
assert os.stat(ROOT + "/" + DATABASE)[6] > 0
guard = Store(native=native, heartbeat=watchdog.feed)
guard._owned_directory()
io = BadgeVFS(ROOT, watchdog.feed)
native.configure(io)
native.open(ROOT + "/" + DATABASE)
try:
    assert native.exec("PRAGMA user_version") == [["1"]]
    assert native.exec("SELECT count(*) FROM ps_crud") == [["0"]]
    original = json.loads(native.exec("SELECT snapshot FROM badge_state WHERE id='current'")[0][0])
    assert original["running"] is False
    assert "clock_saved_s" not in original
    print("ORIGINAL_V1", json.dumps(original))
finally:
    native.close()
    io.close_all()

store = Store(native=native, heartbeat=watchdog.feed)
try:
    store.open()
    migrated = dict(original)
    migrated["clock_saved_s"] = None
    assert store.load() == migrated
    assert native.exec("PRAGMA user_version") == [["2"]]
    assert native.exec("PRAGMA integrity_check") == [["ok"]]
    print("MIGRATION_PRESERVED_ALL_VALUES", json.dumps(migrated))
    candidate = dict(migrated)
    candidate.update(phase="focus", remaining_ms=2400000, running=True,
                     clock_saved_s=rtc_seconds())
    assert type(candidate["clock_saved_s"]) is int
    print("TIMER_CANDIDATE", json.dumps(candidate))
    store.save(candidate)
    assert store.load() == candidate
    print("RUNNING_SNAPSHOT_SAVED", store.version)
finally:
    store.close()
print("DATABASE_CLOSED_SAFE_TO_RESET")
