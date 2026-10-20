"""Cache a host-mounted .mpy in RAM to avoid tiny USB reads during import.

No flash/storage mount is involved. Badgeware already owns its real filesystems.
The temporary Python VFS is removed immediately after import.
"""
import os
import sys
import io
import hashlib
import binascii
import time


class ModuleFS:
    def __init__(self, name, data):
        self.name = "/" + name + ".mpy"
        self.data = data

    def mount(self, readonly, mkfs):
        pass

    def umount(self):
        pass

    def stat(self, path):
        if path == "/":
            return (0x4000, 0, 0, 0, 0, 0, 0, 0, 0, 0)
        if path == self.name:
            return (0x8000, 0, 0, 0, 0, 0, len(self.data), 0, 0, 0)
        raise OSError(2)

    def open(self, path, mode):
        if path != self.name or mode != "rb":
            raise OSError(2)
        return io.BytesIO(self.data)


def load(name, path):
    start = time.ticks_ms()
    with open(path, "rb") as source:
        data = source.read()
    print("RAM_MODULE_BYTES_SHA256", len(data),
          binascii.hexlify(hashlib.sha256(data).digest()).decode())
    fs = ModuleFS(name, data)
    os.mount(fs, "/nativeprobe", readonly=True)
    sys.path.insert(0, "/nativeprobe")
    try:
        result = __import__(name)
        print("RAM_MODULE_IMPORT_MS", time.ticks_diff(time.ticks_ms(), start))
        return result
    finally:
        sys.path.remove("/nativeprobe")
        os.umount("/nativeprobe")
