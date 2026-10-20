"""Run the real core on a new owned database through Badgeware's VFS."""
import sys
import os
import gc
import time
import machine
# Preserve watchdog protection while servicing it during this temporary test.
# A normal reset after database closure restores Badgeware's own lifecycle.
watchdog = machine.WDT(timeout=16000)
sys.path.insert(0, "/remote/tools")
sys.path.insert(0, "/remote/powersync-audit")
from ram_module import load
from badge_vfs import BadgeVFS, ROOT
import device_fixture

sql = load("badge_powersync", "/remote/sqlite-audit/badge_powersync.mpy")
path = ROOT + "/probe-powersync-v2.db"
try:
    os.stat(path)
except OSError as exc:
    if exc.args[0] != 2:
        raise
else:
    raise RuntimeError("Refusing to overwrite an existing core test database")
io = BadgeVFS(heartbeat=watchdog.feed, trace=True)
sql.configure(io)
started = time.ticks_ms()


class TracedSQL:
    def exec(self, text):
        watchdog.feed()
        print("SQL_BEGIN", text[:96])
        result = sql.exec(text)
        watchdog.feed()
        print("SQL_END", sql.stats()[:2])
        return result

    def stats(self):
        return sql.stats()


try:
    print("CORE_OPEN_BEGIN")
    sql.open(path)
    print("CORE_OPEN_END", sql.stats())
    sql.exec("PRAGMA synchronous=FULL")
    device_fixture.fresh(TracedSQL())
    sql.close()
    gc.collect()
    sql.open(path)
    device_fixture.reopened(TracedSQL())
    sql.close()
    assert not io.files
    assert not io.errors, io.errors
    print("POWERSYNC_PERSISTENCE_PASS_MS", time.ticks_diff(time.ticks_ms(), started))
    print("CORE_DATABASE_BYTES", os.stat(path)[6])
finally:
    sql.close()
    io.close_all()
    print("VFS_COUNTS", io.counts)
    print("VFS_TRUNCATIONS", io.truncations)
    print("VFS_ERRORS", io.errors)
print("DATABASE_CLOSED_SAFE_TO_RESET")
