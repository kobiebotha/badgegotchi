"""Host safety tests; real-core tests use the existing pinned host qualifier.

Host POSIX persistence does not qualify the badge VFS or power-loss recovery.
"""
import ctypes as c
import hashlib
import importlib.util
import os
import sys
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "badgegotchi_storage", ROOT / "badge/app/badgegotchi/badgegotchi_storage.py")
storage = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(storage)
HOST_LIBRARY = ROOT / "experiments/badgeware-native/powersync-audit/build/fixture-host.dylib"


class OwnershipTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "badgegotchi"
        self.store = storage.Store(root=str(self.root), native=object())

    def tearDown(self):
        self.temp.cleanup()

    def test_unrelated_directory_is_not_adopted(self):
        self.root.mkdir()
        original = self.root / "keep.txt"
        original.write_text("user data")
        with self.assertRaisesRegex(ValueError, "owner marker"):
            self.store.open()
        self.assertEqual(original.read_text(), "user data")
        self.assertEqual(list(self.root.iterdir()), [original])

    def test_hot_journal_is_retained_before_native_open(self):
        self.store._owned_directory()
        journal = self.root / "state.sqlite-journal"
        journal.write_bytes(b"interrupted data")
        with self.assertRaisesRegex(ValueError, "Interrupted write"):
            self.store.open()
        self.assertEqual(journal.read_bytes(), b"interrupted data")

    def test_unknown_files_and_wrong_markers_are_retained(self):
        self.store._owned_directory()
        (self.root / "private.txt").write_text("keep")
        with self.assertRaisesRegex(ValueError, "Unrecognized"):
            self.store.open()
        (self.root / "owner.txt").write_text("another owner")
        with self.assertRaisesRegex(ValueError, "another app"):
            self.store.open()

    def test_low_space_creates_no_directory(self):
        with patch.object(storage, "_free_bytes", return_value=1024):
            with self.assertRaises(OSError):
                self.store.open()
        self.assertFalse(self.root.exists())

    def test_runtime_rejection_creates_no_state(self):
        def unsupported(_heartbeat):
            raise RuntimeError("Unsupported runtime")
        self.store.native = None
        with patch.dict(sys.modules, {"badgegotchi_runtime": SimpleNamespace(load_native=unsupported)}):
            with self.assertRaisesRegex(RuntimeError, "Unsupported runtime"):
                self.store.open()
        self.assertFalse(self.root.exists())

    def test_snapshot_validation_does_not_coerce_corrupt_values(self):
        for key, value in (("phase", "unknown"), ("running", 1),
                           ("remaining_ms", -1), ("water_count", True),
                           ("pet_count", 1000001)):
            snapshot = dict(storage.DEFAULTS)
            snapshot[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                storage._snapshot(snapshot)

    def test_vfs_exact_paths_and_truncate_failure(self):
        self.store._owned_directory()
        vfs = storage.BadgeVFS(str(self.root))
        self.assertEqual(vfs(0, str(self.root / "../private"), 6, None)[0], 14)
        path = str(self.root / "state.sqlite")
        rc, handle = vfs(0, path, 6, None)
        self.assertEqual(rc, 0)
        self.assertEqual(vfs(3, handle, 0, b"keep"), (0, 4))
        self.assertEqual(vfs(4, handle, 0, None)[0], 1546)
        self.assertEqual(vfs(7, path, 0, None)[0], 10)
        vfs.close_all()
        self.assertEqual(Path(path).read_bytes(), b"keep")

    def test_entropy_and_clock_callbacks(self):
        vfs = storage.BadgeVFS(str(self.root))
        self.assertEqual(len(vfs(9, None, 32, None)[1]), 32)
        self.assertNotEqual(vfs(9, None, 32, None)[1], vfs(9, None, 32, None)[1])
        with patch.object(storage.time, "time", return_value=86401), \
                patch.object(storage.time, "gmtime", return_value=(1970,)):
            self.assertEqual(vfs(10, None, None, None), (0, (1, 1)))
        with patch.object(storage.time, "time", return_value=1), \
                patch.object(storage.time, "gmtime", return_value=(2000,)):
            self.assertEqual(vfs(10, None, None, None), (0, (10957, 1)))


class LoaderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "badgegotchi_native.mpy"
        self.path.write_bytes(b"qualified test artifact")
        identity = SimpleNamespace(NATIVE_BYTES=self.path.stat().st_size,
                                   NATIVE_SHA256=hashlib.sha256(self.path.read_bytes()).hexdigest())
        spec = importlib.util.spec_from_file_location(
            "badgegotchi_runtime", ROOT / "badge/app/badgegotchi/badgegotchi_runtime.py")
        self.runtime = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"badgegotchi_identity": identity}):
            spec.loader.exec_module(self.runtime)
        self.runtime.__file__ = str(Path(self.temp.name) / "badgegotchi_runtime.py")
        self.runtime.sys = SimpleNamespace(
            implementation=SimpleNamespace(name="micropython", version=(1, 29, 0, ""),
                                           _mpy=7942, _build="tufty"),
            modules={}, path=["/unrelated"])
        self.runtime.os = SimpleNamespace(uname=lambda: SimpleNamespace(
            machine="Pimoroni Tufty 2350 with RP2350",
            version="bw-1.29.0-gc,   on 2026-09-22 (GNU 13.3.1 MinSizeRel)"))

    def tearDown(self):
        self.temp.cleanup()

    def test_integrity_and_abi_reject_before_native_import(self):
        self.path.write_bytes(b"changed artifact")
        with self.assertRaisesRegex(RuntimeError, "integrity"):
            self.runtime.load_native()
        self.runtime.sys.implementation._mpy = 0
        with self.assertRaisesRegex(RuntimeError, "build is not qualified"):
            self.runtime.load_native()

    def test_existing_name_collision_is_not_reused(self):
        self.runtime.sys.modules["badgegotchi_native"] = SimpleNamespace(__file__="/unrelated/native.mpy")
        with self.assertRaisesRegex(RuntimeError, "Another native module"):
            self.runtime.load_native()

    def test_only_verified_directory_is_used_and_path_restored(self):
        native = SimpleNamespace(__file__=str(self.path))
        seen = []

        def native_import(name, *_args):
            seen.append((name, self.runtime.sys.path[0]))
            return native

        with patch("builtins.__import__", side_effect=native_import):
            result = self.runtime.load_native()
        self.assertIs(result, native)
        self.assertEqual(seen, [("badgegotchi_native", str(self.path.parent))])
        self.assertEqual(self.runtime.sys.path, ["/unrelated"])


class HostCore:
    """Actual pinned PowerSync extension with native wrapper's text result API."""
    library = None
    arena = None

    def __init__(self):
        if self.library is None:
            lib = c.CDLL(str(HOST_LIBRARY))
            lib.sqlite3_config.argtypes = [c.c_int]
            self.__class__.arena = c.create_string_buffer(256 * 1024)
            self._check_code(lib.sqlite3_config(
                c.c_int(8), c.cast(self.arena, c.c_void_p), c.c_int(len(self.arena)), c.c_int(64)))
            for name, restype, arguments in (
                ("sqlite3_open", c.c_int, [c.c_char_p, c.POINTER(c.c_void_p)]),
                ("sqlite3_close", c.c_int, [c.c_void_p]),
                ("sqlite3_exec", c.c_int, [c.c_void_p, c.c_char_p, c.c_void_p, c.c_void_p, c.c_void_p]),
                ("sqlite3_errmsg", c.c_char_p, [c.c_void_p]),
            ):
                function = getattr(lib, name)
                function.restype, function.argtypes = restype, arguments
            self._check_code(lib.fixture_register())
            self.__class__.library = lib
        self.db = c.c_void_p()

    @staticmethod
    def _check_code(code):
        if code:
            raise RuntimeError("SQLite code %s" % code)

    def configure(self, callback):
        pass  # Host POSIX VFS, explicitly not a badge VFS test.

    def open(self, path):
        self._check_code(self.library.sqlite3_open(path.encode(), c.byref(self.db)))

    def exec(self, sql):
        rows = []
        callback_type = c.CFUNCTYPE(c.c_int, c.c_void_p, c.c_int,
                                   c.POINTER(c.c_char_p), c.POINTER(c.c_char_p))

        @callback_type
        def callback(context, count, values, columns):
            rows.append([None if values[i] is None else values[i].decode() for i in range(count)])
            return 0

        code = self.library.sqlite3_exec(self.db, sql.encode(), callback, None, None)
        if code:
            raise RuntimeError(self.library.sqlite3_errmsg(self.db).decode())
        return rows

    def close(self):
        self._check_code(self.library.sqlite3_close(self.db))
        self.db = c.c_void_p()


@unittest.skipUnless(HOST_LIBRARY.exists(), "Build pinned real-core host qualifier first")
class RealCoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = str(Path(self.temp.name) / "badgegotchi")
        self.native = HostCore()
        self.store = storage.Store(native=self.native, root=self.root)

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def test_actual_local_only_core_retains_running_timer_and_clock(self):
        self.store.open()
        snapshot = self.store.load()
        self.assertEqual(snapshot, storage.DEFAULTS)
        snapshot.update(running=True, remaining_ms=123456, pet_count=3, water_count=2,
                        clock_saved_s=1792526000)
        self.assertTrue(self.store.save(snapshot))
        self.assertFalse(self.store.save(snapshot))
        self.assertEqual(self.native.exec("SELECT count(*) FROM ps_crud"), [["0"]])
        self.assertEqual(self.native.exec("PRAGMA integrity_check"), [["ok"]])
        self.store.close()
        self.store.open()
        self.assertEqual(self.store.load(), snapshot)
        self.assertEqual(self.store.version, "0.5.4/cratesio")

    def test_unknown_schema_version_stays_unchanged(self):
        self.store.open()
        self.native.exec("PRAGMA user_version=99")
        self.store.close()
        path = Path(self.root) / "state.sqlite"
        original = hashlib.sha256(path.read_bytes()).digest()
        with self.assertRaisesRegex(ValueError, "Unsupported database schema"):
            self.store.open()
        self.assertEqual(hashlib.sha256(path.read_bytes()).digest(), original)

    def test_v1_migration_preserves_existing_progress_and_totals(self):
        import json
        self.store.open()
        old = dict(storage.DEFAULTS)
        old.pop("clock_saved_s")
        old.update(remaining_ms=2321000, pet_count=7, water_count=4, stretch_count=2)
        self.native.exec("UPDATE badge_state SET snapshot=%s" % storage._quote(json.dumps(old)))
        self.native.exec("PRAGMA user_version=1")
        self.store.close()
        self.store.open()
        old["clock_saved_s"] = None
        self.assertEqual(self.store.load(), old)
        self.assertEqual(self.native.exec("PRAGMA user_version"), [["2"]])
        self.assertEqual(self.native.exec("PRAGMA integrity_check"), [["ok"]])
        self.assertEqual(self.native.exec("SELECT count(*) FROM ps_crud"), [["0"]])

    def test_corrupt_snapshot_is_retained(self):
        self.store.open()
        self.native.exec("UPDATE badge_state SET snapshot='{}'")
        self.store.close()
        with self.assertRaisesRegex(ValueError, "Unsupported saved state"):
            self.store.open()


if __name__ == "__main__":
    unittest.main()
