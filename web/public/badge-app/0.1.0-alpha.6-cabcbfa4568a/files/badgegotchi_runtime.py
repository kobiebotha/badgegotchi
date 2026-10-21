"""Load only the artifact qualified for this exact Badgeware ABI."""
import binascii
import hashlib
import os
import sys

from badgegotchi_identity import NATIVE_BYTES, NATIVE_SHA256


def load_native(heartbeat=None):
    implementation = sys.implementation
    uname = os.uname()
    if (implementation.name != "micropython"
            or implementation.version[:3] != (1, 29, 0)
            or getattr(implementation, "_mpy", None) != 7942
            or getattr(implementation, "_build", None) != "tufty"
            or uname.machine != "Pimoroni Tufty 2350 with RP2350"
            or uname.version != "bw-1.29.0-gc,   on 2026-09-22 (GNU 13.3.1 MinSizeRel)"):
        raise RuntimeError("Badgeware build is not qualified for this app")
    directory = __file__.rsplit("/", 1)[0] if "/" in __file__ else "."
    if not directory.startswith("/"):
        directory = os.getcwd().rstrip("/") + "/" + directory
        if directory.endswith("/."):
            directory = directory[:-2]
    native_path = directory + "/badgegotchi_native.mpy"
    digest = hashlib.sha256()
    length = 0
    with open(native_path, "rb") as source:
        while True:
            block = source.read(4096)
            if not block:
                break
            digest.update(block)
            length += len(block)
            if heartbeat:
                heartbeat()
    actual = binascii.hexlify(digest.digest()).decode()
    if length != NATIVE_BYTES or actual != NATIVE_SHA256:
        raise RuntimeError("Native module integrity check failed")
    # The app directory is on Badgeware's import path. Native code persists until
    # the normal launcher VM reset; do not delete/reimport this module per view.
    if heartbeat:
        heartbeat()
    loaded = sys.modules.get("badgegotchi_native")
    if loaded is not None and getattr(loaded, "__file__", None) != native_path:
        raise RuntimeError("Another native module uses this app's module name")
    # Resolve from the exact verified directory, ahead of other app/global paths.
    sys.path.insert(0, directory)
    try:
        import badgegotchi_native
    finally:
        sys.path.pop(0)
    if getattr(badgegotchi_native, "__file__", None) != native_path:
        raise RuntimeError("Native module did not load from this app")
    if heartbeat:
        heartbeat()
    return badgegotchi_native
