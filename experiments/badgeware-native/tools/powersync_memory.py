"""Real pinned PowerSync extension checkpoint/outbox fixture in PSRAM."""
import sys
import gc
import time
sys.path.insert(0, "/remote/tools")
sys.path.insert(0, "/remote/powersync-audit")
from ram_module import load
import device_fixture

gc.collect()
before = gc.mem_free()
sql = load("badge_powersync", "/remote/sqlite-audit/badge_powersync.mpy")
gc.collect()
print("CORE_RETAINED_BYTES", before - gc.mem_free())
started = time.ticks_ms()
sql.open(":memory:")
try:
    device_fixture.fresh(sql)
    gc.collect()
    device_fixture.reopened(sql)
finally:
    sql.close()
print("CORE_CLOSED_STATS", sql.stats(), gc.mem_free())
print("POWERSYNC_MEMORY_PASS_MS", time.ticks_diff(time.ticks_ms(), started))
