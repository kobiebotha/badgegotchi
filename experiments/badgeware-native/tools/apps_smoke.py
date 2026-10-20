"""Bounded display/app smoke using installed app code, without editing apps."""
import sys
import os
import gc
import builtins
import machine
import badgeware
sys.path.insert(0, "/remote/tools")
from ram_module import load
from badge_vfs import BadgeVFS, ROOT

watchdog = machine.WDT(timeout=16000)
sql = load("badge_powersync", "/remote/sqlite-audit/badge_powersync.mpy")
io = BadgeVFS(heartbeat=watchdog.feed)
sql.configure(io)
sql.open(ROOT + "/probe-powersync-v2.db")
original_run = run
frames = [0]


def bounded_run(update):
    def frame():
        watchdog.feed()
        frames[0] += 1
        return update()
    return badgeware._run(frame, duration=250)


try:
    builtins.run = bounded_run
    for path in ("/system/apps/pomogotchi", "/system/apps/dots_boxes"):
        before = frames[0]
        badgeware.launch(path)
        assert frames[0] > before + 1
        assert path not in sys.modules
        os.chdir("/")
        gc.collect()
        assert sql.exec("SELECT name FROM items WHERE id='hello'") == [["Hello world"]]
        assert sql.exec("SELECT count(*) FROM ps_crud") == [["2"]]
        print("INSTALLED_APP_PASS", path, frames[0] - before, gc.mem_free())
finally:
    builtins.run = original_run
    sql.close()
    io.close_all()
print("EXISTING_APPS_AND_CORE_GC_PASS")
print("DATABASE_CLOSED_SAFE_TO_RESET")
