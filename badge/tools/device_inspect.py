"""Read runtime metadata and preservation fingerprints, never secret contents.

Run with mpremote resume run. No files are created on the badge.
Secret/settings paths receive stat metadata only. Application code and assets
are hashed on the device; their contents are not copied to the host.
"""
import sys
import os
import gc
import json
import hashlib
import binascii
import machine

watchdog = machine.WDT(timeout=16000)

print("IMPLEMENTATION", sys.implementation)
print("UNAME", os.uname())
print("MPY", sys.implementation._mpy)
try:
    import version
    for key in ("DATE", "BUILD", "MICROPYTHON_SHA", "PIMORONI_PICO_SHA"):
        print("VERSION", key, getattr(version, key, None))
except ImportError:
    print("VERSION module unavailable")
gc.collect()
print("MEMORY", gc.mem_free(), gc.mem_alloc())
print("PATH", sys.path)
for path in ("/", "/system", "/state", "/system/apps", "/system/lib", "/rom"):
    print("DIRECTORY", path, sorted(os.listdir(path)))
for path in ("/", "/system", "/state"):
    print("STATVFS", path, os.statvfs(path))


def fingerprint(path):
    for name in sorted(os.listdir(path)):
        watchdog.feed()
        child = path.rstrip("/") + "/" + name
        if child == "/state/badgegotchi-feasibility":
            print("OWNED_PATH_ALREADY_EXISTS", child)
            continue
        stat = os.stat(child)
        if stat[0] & 0x4000:
            fingerprint(child)
        else:
            # Avoid reading personal/secret data, including all state files.
            sensitive = (child.startswith("/state/") or
                         "secret" in name.lower() or name.startswith(".") or
                         child.startswith("/powerbadge/") or
                         name.endswith(".json"))
            digest = None
            if not sensitive:
                h = hashlib.sha256()
                with open(child, "rb") as source:
                    while True:
                        watchdog.feed()
                        block = source.read(2048)
                        if not block:
                            break
                        h.update(block)
                digest = binascii.hexlify(h.digest()).decode()
            print("FILE", json.dumps([child, list(stat), digest]))


fingerprint("/system")
fingerprint("/state")
print("INSPECT_COMPLETE")
