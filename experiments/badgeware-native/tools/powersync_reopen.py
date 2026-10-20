"""Verify the real core's retained synced state and outbox after reset."""
import sys
import os
import machine
watchdog = machine.WDT(timeout=16000)
sys.path.insert(0, "/remote/tools")
sys.path.insert(0, "/remote/powersync-audit")
from ram_module import load
from badge_vfs import BadgeVFS, ROOT
import device_fixture

sql = load("badge_powersync", "/remote/sqlite-audit/badge_powersync.mpy")
path = ROOT + "/probe-powersync-v2.db"
assert os.stat(path)[6] > 0
io = BadgeVFS(heartbeat=watchdog.feed)
sql.configure(io)
try:
    sql.open(path)
    device_fixture.reopened(sql)
    print("POWERSYNC_RESET_REOPEN_PASS")
finally:
    sql.close()
    io.close_all()
    print("VFS_COUNTS", io.counts)
    print("VFS_ERRORS", io.errors)
print("DATABASE_CLOSED_SAFE_TO_RESET")
