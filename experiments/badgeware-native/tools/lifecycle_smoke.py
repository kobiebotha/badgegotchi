"""Host-mounted native app entry/exit/re-entry through Badgeware launch()."""
import sys
import os
import gc
import badgeware

if "/remote" not in sys.path:
    sys.path.insert(0, "/remote")
for cycle in range(3):
    gc.collect()
    before = gc.mem_free()
    result = badgeware.launch("/remote/app")
    assert result == "native-app-exit-ok", result
    assert "badgeprobe" not in sys.modules
    assert "/remote/app" not in sys.modules
    # Badgeware removes /system/apps paths, but our temporary host mount
    # deliberately lives elsewhere. Restore only this experiment's entry.
    if sys.path[0] == "/remote/app":
        sys.path.pop(0)
    os.chdir("/")
    gc.collect()
    print("LIFECYCLE", cycle, result, before, gc.mem_free())
print("LIFECYCLE_SMOKE_PASS")
