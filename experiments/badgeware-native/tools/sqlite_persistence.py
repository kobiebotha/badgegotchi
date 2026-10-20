"""Create only a new owned database; close it before any reset."""
import sys
import os
import gc
sys.path.insert(0, "/remote/tools")
sys.path.insert(0, "/remote/sqlite-audit")
from ram_module import load
sql = load("badge_sqlite", "/remote/sqlite-audit/badge_sqlite.mpy")
from badge_vfs import BadgeVFS, ROOT, ensure_owned_root

ensure_owned_root(create=True)
path = ROOT + "/probe-sqlite-v1.db"
try:
    os.stat(path)
except OSError as exc:
    if exc.args[0] != 2:
        raise
else:
    raise RuntimeError("Refusing to overwrite an existing test database")
io = BadgeVFS()
sql.configure(io)
try:
    sql.open(path)
    assert sql.exec("PRAGMA journal_mode=DELETE") == [["delete"]]
    sql.exec("PRAGMA synchronous=FULL")
    sql.exec("CREATE TABLE proof(id INTEGER PRIMARY KEY,value TEXT)")
    sql.exec("BEGIN;INSERT INTO proof VALUES(1,'committed');COMMIT")
    sql.exec("BEGIN;UPDATE proof SET value='discarded';INSERT INTO proof VALUES(2,'rolled back');ROLLBACK")
    assert sql.exec("SELECT id,value FROM proof") == [["1", "committed"]]
    assert sql.exec("PRAGMA integrity_check") == [["ok"]]
    print("PERSISTENT_OPEN_STATS", sql.stats())
    sql.close()
    gc.collect()
    sql.open(path)
    assert sql.exec("SELECT id,value FROM proof") == [["1", "committed"]]
    assert sql.exec("PRAGMA integrity_check") == [["ok"]]
    sql.close()
    assert not io.files
    assert not io.errors, io.errors
    print("SQLITE_PERSISTENCE_PASS", os.stat(path)[6])
finally:
    sql.close()
    io.close_all()
    print("VFS_COUNTS", io.counts)
    print("VFS_TRUNCATIONS", io.truncations)
    print("VFS_ERRORS", io.errors)
print("DATABASE_CLOSED_SAFE_TO_RESET")
