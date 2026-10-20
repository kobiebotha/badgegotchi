"""Real SQLite in-memory transaction and repeated close/open smoke."""
import sys
import gc
import time
sys.path.insert(0, "/remote/sqlite-audit")
sys.path.insert(0, "/remote/tools")
from ram_module import load
gc.collect()
before = gc.mem_free()
started = time.ticks_ms()
sql = load("badge_sqlite", "/remote/sqlite-audit/badge_sqlite.mpy")
print("SQLITE_IMPORT_MS", time.ticks_diff(time.ticks_ms(), started))
print("SQLITE_IMPORT_BYTES", before - gc.mem_free())
for cycle in range(6):
    sql.open(":memory:")
    try:
        sql.exec("CREATE TABLE proof(id INTEGER PRIMARY KEY,value TEXT)")
        sql.exec("BEGIN;INSERT INTO proof VALUES(1,'committed');COMMIT")
        sql.exec("BEGIN;UPDATE proof SET value='discarded';ROLLBACK")
        assert sql.exec("SELECT id,value FROM proof") == [["1", "committed"]]
        assert sql.exec("SELECT 1.25+0.5") == [["1.75"]]
        assert sql.exec("PRAGMA integrity_check") == [["ok"]]
        gc.collect()
        assert sql.exec("SELECT value FROM proof") == [["committed"]]
        print("SQLITE_OPEN_STATS", cycle, sql.stats())
    finally:
        sql.close()
    gc.collect()
    print("SQLITE_CLOSED_STATS", cycle, sql.stats(), gc.mem_free())
print("SQLITE_MEMORY_PASS")
