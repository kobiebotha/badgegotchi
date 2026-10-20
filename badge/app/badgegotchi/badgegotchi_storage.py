"""Small, local-only PowerSync store on Badgeware's existing LittleFS mount.

The recognized v1 snapshot has one additive migration for timer clock state.
A leftover journal or unrecognized data is retained, never removed/reset.
"""
import json
import os
import time

ROOT = "/state/badgegotchi"
OWNER = "badgegotchi-app-local-alpha-v1\n"
DATABASE = "state.sqlite"
MAX_DATABASE_BYTES = 128 * 1024
MIN_FREE_BYTES = 64 * 1024
SCHEMA = ('{"tables":[{"name":"badge_state","local_only":true,'
          '"columns":[{"name":"snapshot","type":"text"}]}]}')
DEFAULTS = {
    "phase": "focus", "remaining_ms": 2400000, "running": False,
    "focus_count": 0, "water_count": 0, "stretch_count": 0, "pet_count": 0,
    "clock_saved_s": None,
}


def _stat(path):
    try:
        return os.stat(path)
    except OSError as exc:
        if exc.args[0] != 2:
            raise
        return None


def _quote(value):
    return "'" + value.replace("'", "''") + "'"


def _snapshot(value, legacy=False):
    keys = set(DEFAULTS) - ({"clock_saved_s"} if legacy else set())
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError("Unsupported saved state")
    if value["phase"] not in ("focus", "break") or type(value["running"]) is not bool:
        raise ValueError("Invalid timer state")
    for key in DEFAULTS:
        if key in ("phase", "running", "clock_saved_s"):
            continue
        limit = (2400000 if value["phase"] == "focus" else 600000) if key == "remaining_ms" else 1000000
        if type(value[key]) is not int or not 0 <= value[key] <= limit:
            raise ValueError("Invalid saved counter")
    result = dict(value)
    if legacy:
        # v1 intentionally paused on reentry and had no trustworthy time anchor.
        result["running"] = False
        result["clock_saved_s"] = None
    saved_at = result["clock_saved_s"]
    if saved_at is not None and (type(saved_at) is not int or not 1704067200 <= saved_at < 4102444800):
        raise ValueError("Invalid saved clock")
    if not result["running"] and saved_at is not None:
        raise ValueError("Paused timer has a clock anchor")
    if len(json.dumps(result)) > 512:
        raise ValueError("Saved state is too large")
    return result


def _free_bytes(root):
    stat = os.statvfs(root)
    return stat[1] * stat[4]


class BadgeVFS:
    """One connection, two exact files, DELETE journaling, no concurrent access."""

    def __init__(self, root, heartbeat=None):
        self.paths = (root + "/" + DATABASE, root + "/" + DATABASE + "-journal")
        self.files = {}
        self.next_handle = 1
        self.heartbeat = heartbeat
        self.last_error = None

    def _path(self, path):
        if path not in self.paths:
            raise ValueError("Storage path is not owned by Badgegotchi")
        return path

    def __call__(self, op, item, arg1, arg2):
        try:
            if self.heartbeat:
                self.heartbeat()
            if op == 9:
                if not 0 <= arg1 <= 512:
                    raise ValueError("Invalid entropy request")
                return (0, os.urandom(arg1))
            if op == 10:
                # RP2 epochs may start in 2000; the SQLite ABI uses Unix days.
                seconds = int(time.time())
                if time.gmtime(0)[0] == 2000:
                    seconds += 946684800
                elif time.gmtime(0)[0] != 1970:
                    raise ValueError("Unsupported clock epoch")
                return (0, (seconds // 86400, seconds % 86400))
            if op == 0:
                path = self._path(item)
                if any(entry[1] == path for entry in self.files.values()):
                    return (5, 0)
                flags = arg1
                exists = _stat(path) is not None
                if (not exists and not flags & 4) or (exists and flags & 16):
                    return (14, 0)
                mode = "rb" if flags & 1 else ("r+b" if exists else "x+b")
                stream = open(path, mode)
                handle = self.next_handle
                self.next_handle += 1
                self.files[handle] = (stream, path, flags)
                return (0, handle)
            if op == 7:
                path = self._path(item)
                if path != self.paths[1]:
                    raise ValueError("Database deletion is not supported")
                if _stat(path) is not None:
                    os.remove(path)
                if arg1:
                    os.sync()
                return (0, 0)
            if op == 8:
                return (0, int(_stat(self._path(item)) is not None))
            stream, path, flags = self.files[item]
            if op == 1:
                stream.close()
                del self.files[item]
                if flags & 8:
                    if path != self.paths[1]:
                        raise ValueError("Database deletion is not supported")
                    os.remove(path)
                return (0, 0)
            if op == 2:
                stream.seek(arg1)
                return (0, stream.read(arg2))
            if op == 3:
                # Journal overhead is bounded independently from DB page count.
                if arg1 < 0 or arg1 + len(arg2) > MAX_DATABASE_BYTES + 4096:
                    return (13, 0)  # SQLITE_FULL
                stream.seek(arg1)
                return (0, stream.write(arg2))
            if op == 4:
                stream.seek(0, 2)
                size = stream.tell()
                if arg1 < size:
                    self.last_error = "File truncation is unavailable"
                    return (1546, 0)
                if arg1 > MAX_DATABASE_BYTES:
                    return (13, 0)
                if arg1 > size:
                    stream.seek(arg1 - 1)
                    if stream.write(b"\0") != 1:
                        return (10, 0)
                return (0, 0)
            if op == 5:
                stream.flush()  # Badgeware LittleFS file_sync.
                os.sync()
                return (0, 0)
            if op == 6:
                position = stream.tell()
                stream.seek(0, 2)
                size = stream.tell()
                stream.seek(position)
                return (0, size)
            return (10, 0)
        except Exception as exc:
            self.last_error = type(exc).__name__ + ": " + str(exc)
            return (14 if op == 0 else 10, 0)

    def close_all(self):
        for handle in list(self.files):
            if self(1, handle, 0, 0)[0]:
                raise OSError("Could not close Badgegotchi storage")


class Store:
    def __init__(self, heartbeat=None, native=None, root=ROOT):
        if not root.startswith("/") or root.endswith("/") or "/../" in root:
            raise ValueError("Storage needs an absolute owned directory")
        self.root = root
        self.heartbeat = heartbeat
        self.native = native
        self.io = None
        self.opened = False
        self.version = None
        self._last = None

    def _feed(self):
        if self.heartbeat:
            self.heartbeat()

    def _exec(self, sql):
        self._feed()
        result = self.native.exec(sql)
        self._feed()
        return result

    def _scalar(self, sql):
        rows = self._exec(sql)
        if len(rows) != 1 or len(rows[0]) != 1:
            raise ValueError("Unexpected database result")
        return rows[0][0]

    def _owned_directory(self):
        marker = self.root + "/owner.txt"
        if _stat(self.root) is None:
            parent = self.root.rsplit("/", 1)[0] or "/"
            if _free_bytes(parent) < MAX_DATABASE_BYTES + MIN_FREE_BYTES:
                raise OSError("Not enough free badge storage")
            os.mkdir(self.root)
            with open(marker, "x") as target:
                target.write(OWNER)
                target.flush()
        else:
            if _stat(marker) is None:
                raise ValueError("Badgegotchi directory has no owner marker")
            with open(marker) as source:
                if source.read(128) != OWNER:
                    raise ValueError("Badgegotchi directory belongs to another app")
        allowed = ("owner.txt", DATABASE, DATABASE + "-journal")
        for name in os.listdir(self.root):
            info = os.stat(self.root + "/" + name)
            if name not in allowed or info[0] & 0xf000 != 0x8000:
                raise ValueError("Unrecognized Badgegotchi data; retained unchanged")
        journal = _stat(self.root + "/" + DATABASE + "-journal")
        if journal and journal[6]:
            raise ValueError("Interrupted write; database and journal retained")

    def open(self):
        if self.opened:
            return self
        if self.native is None:
            from badgegotchi_runtime import load_native
            self.native = load_native(self.heartbeat)
        self._owned_directory()
        path = self.root + "/" + DATABASE
        before = _stat(path)
        if before and (before[6] == 0 or before[6] > MAX_DATABASE_BYTES):
            raise ValueError("Unrecognized database size; retained unchanged")
        self.io = BadgeVFS(self.root, self.heartbeat)
        self.native.configure(self.io)
        try:
            self.native.open(path)
            self.opened = True
            self.version = self._scalar("SELECT powersync_rs_version()")
            if self.version != "0.5.4/cratesio":
                raise ValueError("Unsupported PowerSync core")
            schema_version = self._scalar("PRAGMA user_version") if before else None
            if before and schema_version not in ("1", "2"):
                raise ValueError("Unsupported database schema; retained unchanged")
            if before and self._scalar("PRAGMA quick_check") != "ok":
                raise ValueError("Database integrity check failed; retained unchanged")
            self._exec("PRAGMA page_size=1024")
            if self._scalar("PRAGMA page_size") != "1024":
                raise ValueError("Unsupported database page size")
            self._exec("PRAGMA max_page_count=128")
            self._exec("PRAGMA cache_size=8")
            self._exec("PRAGMA temp_store=MEMORY")
            self._exec("PRAGMA synchronous=FULL")
            if self._scalar("PRAGMA journal_mode=DELETE") != "delete":
                raise ValueError("DELETE journaling is required")
            if before:
                if schema_version == "1":
                    value = self._load_snapshot(legacy=True)
                    self._check_reserve()
                    self._exec("BEGIN IMMEDIATE")
                    try:
                        self._exec("UPDATE badge_state SET snapshot=%s WHERE id='current'" % _quote(json.dumps(value)))
                        self._exec("PRAGMA user_version=2")
                        self._exec("COMMIT")
                    except Exception:
                        self._exec("ROLLBACK")
                        raise
                else:
                    self.load()
            else:
                self._exec("BEGIN IMMEDIATE")
                try:
                    self._exec("SELECT powersync_replace_schema(%s)" % _quote(SCHEMA))
                    payload = json.dumps(DEFAULTS)
                    self._exec("INSERT INTO badge_state(id,snapshot) VALUES('current',%s)" % _quote(payload))
                    self._exec("PRAGMA user_version=2")
                    self._exec("COMMIT")
                except Exception:
                    self._exec("ROLLBACK")
                    raise
            if self._scalar("SELECT count(*) FROM ps_crud") != "0":
                raise ValueError("Local-only database unexpectedly contains an outbox")
            return self
        except Exception:
            self.close()
            raise

    def load(self):
        if not self.opened:
            raise ValueError("Database is not open")
        self._last = None
        return self._load_snapshot()

    def _load_snapshot(self, legacy=False):
        rows = self._exec("SELECT id,snapshot FROM badge_state LIMIT 2")
        if len(rows) != 1 or rows[0][0] != "current" or len(rows[0][1]) > 512:
            raise ValueError("Unsupported saved state; retained unchanged")
        return _snapshot(json.loads(rows[0][1]), legacy)

    def _check_reserve(self):
        database_size = os.stat(self.root + "/" + DATABASE)[6]
        if _free_bytes(self.root) < MIN_FREE_BYTES + database_size + 8192:
            raise OSError("Badge storage reserve is low; save stopped")

    def save(self, snapshot):
        if not self.opened:
            raise ValueError("Database is not open")
        value = _snapshot(snapshot)
        if value == self._last:
            return False
        # Retain room for a worst-case rollback journal as well as the shared
        # filesystem reserve. The app never consumes the rest of Badgeware's
        # small state partition merely because SQLite has free pages left.
        self._check_reserve()
        self._exec("BEGIN IMMEDIATE")
        try:
            self._exec("UPDATE badge_state SET snapshot=%s WHERE id='current'" % _quote(json.dumps(value)))
            self._exec("COMMIT")
        except Exception:
            self._exec("ROLLBACK")
            raise
        self._last = value
        return True

    def close(self):
        if self.opened:
            self._feed()
            self.native.close()
            self.opened = False
        if self.io:
            self.io.close_all()
            self.io = None
