"""Small reproducers for exception containment and unsupported truncation."""
import sys
import os
import machine
sys.path.insert(0, "/remote/tools")
from ram_module import load
from badge_vfs import BadgeVFS, ROOT

watchdog = machine.WDT(timeout=16000)
sql = load("badge_sqlite", "/remote/sqlite-audit/badge_sqlite.mpy")


def raises(*args):
    raise OSError(5)


sql.configure(raises)
try:
    sql.open(ROOT + "/probe-must-not-exist.db")
except RuntimeError:
    print("CALLBACK_EXCEPTION_CONTAINED")
else:
    raise AssertionError("VFS exception was not returned as a SQLite error")
sql.open(":memory:")
assert sql.exec("SELECT 42") == [["42"]]
sql.close()
print("RUNTIME_USABLE_AFTER_CALLBACK_EXCEPTION")

path = ROOT + "/probe-truncate-v1.db"
try:
    os.stat(path)
except OSError as exc:
    if exc.args[0] != 2:
        raise
else:
    raise RuntimeError("Refusing to overwrite truncate reproducer")
io = BadgeVFS(heartbeat=watchdog.feed)
sql.configure(io)
try:
    sql.open(path)
    assert sql.exec("PRAGMA journal_mode=TRUNCATE") == [["truncate"]]
    try:
        sql.exec("CREATE TABLE shrink_test(id INTEGER)")
    except RuntimeError:
        assert any(item[0] == "truncate-unavailable" for item in io.errors)
        print("EXPECTED_BLOCKER_TRUNCATE_JOURNAL")
    else:
        raise AssertionError("Expected unsupported truncate operation")
finally:
    sql.close()
    io.close_all()
    print("VFS_COUNTS", io.counts)
    print("VFS_TRUNCATIONS", io.truncations)
    print("VFS_ERRORS", io.errors)
print("DATABASE_CLOSED_SAFE_TO_RESET")
