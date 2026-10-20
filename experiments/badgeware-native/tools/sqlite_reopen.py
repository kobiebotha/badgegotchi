"""Verify the committed owned database after a controlled normal reset."""
import sys
import os
sys.path.insert(0, "/remote/tools")
sys.path.insert(0, "/remote/sqlite-audit")
from ram_module import load
sql = load("badge_sqlite", "/remote/sqlite-audit/badge_sqlite.mpy")
from badge_vfs import BadgeVFS, ROOT

path = ROOT + "/probe-sqlite-v1.db"
assert os.stat(path)[6] > 0
io = BadgeVFS()
sql.configure(io)
try:
    sql.open(path)
    assert sql.exec("SELECT id,value FROM proof") == [["1", "committed"]]
    assert sql.exec("PRAGMA integrity_check") == [["ok"]]
    print("SQLITE_RESET_REOPEN_PASS", sql.stats())
finally:
    sql.close()
    io.close_all()
    print("VFS_COUNTS", io.counts)
    print("VFS_ERRORS", io.errors)
print("DATABASE_CLOSED_SAFE_TO_RESET")
