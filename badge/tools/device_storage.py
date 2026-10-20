"""Qualify the installed native app on a fresh, owned database.

Run after installing the ZIP, before using the app. Refuses any non-default
saved snapshot. The matching device_reopen.py checks reset persistence and
restores the original defaults. No other app or database is opened.
"""
import gc
import machine
import sys
import time

sys.path.insert(0, "/system/apps/badgegotchi")
from badgegotchi_storage import Store, DEFAULTS

watchdog = machine.WDT(timeout=16000)
started = time.ticks_ms()
store = Store(heartbeat=watchdog.feed)
try:
    store.open()
    print("NATIVE_FILE", store.native.__file__)
    print("CORE_VERSION", store.version)
    original = store.load()
    assert original == DEFAULTS, "Refusing to change existing non-default app data"
    first = store.native.exec("SELECT hex(randomblob(16))")[0][0]
    second = store.native.exec("SELECT hex(randomblob(16))")[0][0]
    assert first != second
    print("ENTROPY_CALLBACK_PASS")
    print("SQL_CLOCK", store.native.exec("SELECT datetime('now')"))
    snapshot = dict(original)
    snapshot.update(running=True, remaining_ms=123456, pet_count=1, water_count=2, stretch_count=3)
    store.save(snapshot)
    assert store.native.exec("SELECT count(*) FROM ps_crud") == [["0"]]
    assert store.native.exec("PRAGMA integrity_check") == [["ok"]]
    store.close()
    gc.collect()
    store.open()
    snapshot["running"] = False
    assert store.load() == snapshot
    print("APP_STORE_CLOSE_REOPEN_PASS", store.native.stats())
    print("APP_STORE_ELAPSED_MS", time.ticks_diff(time.ticks_ms(), started))
finally:
    store.close()
print("DATABASE_CLOSED_SAFE_TO_RESET")
