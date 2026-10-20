"""Restricted SQLite callback bridge to Badgeware's already-mounted VFS.

One native SQLite connection, no other process may access these test files.
The baseline implementation explicitly rejects shrinking a file, because the
installed LittleFS file API has no truncate operation. It never pretends a
failed storage operation succeeded. A separate adapter can be qualified later.
"""
import os

ROOT = "/state/badgegotchi-feasibility"
MARKER = ROOT + "/owner.txt"
OWNER = "badgegotchi-native-feasibility-2026-10-20-v1\n"


def ensure_owned_root(create=False):
    try:
        os.stat(ROOT)
    except OSError as exc:
        if exc.args[0] != 2 or not create:
            raise
        os.mkdir(ROOT)
        with open(MARKER, "x") as target:
            target.write(OWNER)
            target.flush()
    else:
        # Existing unrelated directories are never adopted.
        with open(MARKER) as source:
            if source.read() != OWNER:
                raise RuntimeError("Refusing unrelated feasibility directory")


class BadgeVFS:
    def __init__(self, heartbeat=None, trace=False):
        ensure_owned_root()
        self.files = {}
        self.next_handle = 1
        self.counts = [0] * 9
        self.errors = []
        self.truncations = []
        self.heartbeat = heartbeat
        self.trace = trace

    def _path(self, path):
        if not isinstance(path, str) or not path.startswith(ROOT + "/"):
            raise ValueError("Path outside isolated test directory")
        name = path[len(ROOT) + 1:]
        if "/" in name or ".." in name or not name.startswith("probe-"):
            raise ValueError("Not an owned test database path")
        return path

    def __call__(self, op, item, arg1, arg2):
        try:
            if self.heartbeat:
                self.heartbeat()
            self.counts[op] += 1
            if self.trace:
                print("VFS", op, item, arg1, len(arg2) if isinstance(arg2, bytes) else arg2)
            if op == 0:  # OPEN
                path = self._path(item)
                if any(entry[1] == path for entry in self.files.values()):
                    return (5, 0)  # SQLITE_BUSY: only one handle per path.
                flags = arg1
                try:
                    os.stat(path)
                    exists = True
                except OSError as exc:
                    if exc.args[0] != 2:
                        raise
                    exists = False
                if not exists and not (flags & 4):
                    return (14, 0)  # SQLITE_CANTOPEN
                if exists and (flags & 16):
                    return (14, 0)
                mode = "rb" if flags & 1 else ("r+b" if exists else "x+b")
                file = open(path, mode)
                handle = self.next_handle
                self.next_handle += 1
                self.files[handle] = (file, path, flags)
                return (0, handle)
            if op == 7:  # DELETE
                path = self._path(item)
                try:
                    os.remove(path)
                except OSError as exc:
                    if exc.args[0] != 2:
                        raise
                if arg1:
                    os.sync()
                return (0, 0)
            if op == 8:  # ACCESS
                try:
                    os.stat(self._path(item))
                    return (0, 1)
                except OSError as exc:
                    if exc.args[0] == 2:
                        return (0, 0)
                    raise
            file, path, flags = self.files[item]
            if op == 1:
                file.close()
                del self.files[item]
                if flags & 8:
                    os.remove(path)
                return (0, 0)
            if op == 2:
                file.seek(arg1)
                return (0, file.read(arg2))
            if op == 3:
                file.seek(arg1)
                return (0, file.write(arg2))
            if op == 4:
                file.seek(0, 2)
                size = file.tell()
                self.truncations.append((size, arg1))
                if arg1 == size:
                    return (0, 0)
                if arg1 < size:
                    self.errors.append(("truncate-unavailable", size, arg1))
                    return (1546, 0)  # SQLITE_IOERR_TRUNCATE
                # Growing does not require a missing API.
                file.seek(arg1 - 1)
                file.write(b"\0")
                return (0, 0)
            if op == 5:
                file.flush()  # LFS file_sync through MP_STREAM_FLUSH.
                os.sync()
                return (0, 0)
            if op == 6:
                position = file.tell()
                file.seek(0, 2)
                size = file.tell()
                file.seek(position)
                return (0, size)
            return (10, 0)
        except Exception as exc:
            self.errors.append((op, type(exc).__name__, str(exc)))
            return (14 if op == 0 else 10, 0)

    def close_all(self):
        for handle in list(self.files):
            self(1, handle, 0, 0)
