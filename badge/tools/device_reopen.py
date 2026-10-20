"""Verify the controlled-reset fixture, then restore its initial empty state."""
import machine
import sys

sys.path.insert(0, "/system/apps/badgegotchi")
from badgegotchi_storage import Store, DEFAULTS

watchdog = machine.WDT(timeout=16000)
store = Store(heartbeat=watchdog.feed)
try:
    store.open()
    expected = dict(DEFAULTS)
    expected.update(remaining_ms=123456, pet_count=1, water_count=2, stretch_count=3)
    assert store.load() == expected, "Unexpected app state; preserving it unchanged"
    assert store.native.exec("PRAGMA integrity_check") == [["ok"]]
    assert store.native.exec("SELECT count(*) FROM ps_crud") == [["0"]]
    print("APP_STORE_RESET_PERSISTENCE_PASS")
    store.save(DEFAULTS)
    assert store.load() == DEFAULTS
    print("APP_TEST_STATE_RESTORED")
finally:
    store.close()
print("DATABASE_CLOSED_SAFE_TO_RESET")
