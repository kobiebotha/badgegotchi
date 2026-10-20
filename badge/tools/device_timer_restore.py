"""Check elapsed time after a reset and restore exact captured user progress.

Prepend FIXTURE_ORIGINAL_JSON and FIXTURE_CANDIDATE_JSON from the printed
values in device_timer_upgrade.py. Refuses a different on-device snapshot. Restores the
original even when the timing assertions fail after that identity check.
"""
import json
import machine
import sys

sys.path.insert(0, "/system/apps/badgegotchi")
from badgegotchi_state import AppState, rtc_seconds
from badgegotchi_storage import Store

original = json.loads(FIXTURE_ORIGINAL_JSON)
candidate = json.loads(FIXTURE_CANDIDATE_JSON)
watchdog = machine.WDT(timeout=16000)
store = Store(heartbeat=watchdog.feed)
try:
    store.open()
    saved = store.load()
    assert saved == candidate, "Saved progress changed; refusing fixture restore"
    try:
        now = rtc_seconds()
        state = AppState(saved, clock=lambda: now)
        elapsed = now - candidate["clock_saved_s"]
        assert 0 < elapsed < 2400
        assert state.running
        assert state.remaining_ms == candidate["remaining_ms"] - elapsed * 1000
        for key in ("pet_count", "focus_count", "water_count", "stretch_count"):
            assert getattr(state, key) == original[key]
        print("RESET_ELAPSED_TIMER_PASS", elapsed, state.remaining_ms)
    finally:
        store.save(original)
        assert store.load() == original
        print("ORIGINAL_USER_PROGRESS_RESTORED", json.dumps(original))
    assert store.native.exec("PRAGMA integrity_check") == [["ok"]]
    assert store.native.exec("SELECT count(*) FROM ps_crud") == [["0"]]
    print("CORE_AND_INTEGRITY_PASS", store.version)
finally:
    store.close()
print("DATABASE_CLOSED_SAFE_TO_RESET")
