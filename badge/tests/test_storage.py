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

    def test_account_only_store_has_no_badge_progress_and_retains_binding(self):
        self.store.open()
        self.assertEqual(self.native.exec("SELECT count(*) FROM badge_state"), [["0"]])
        self.assertEqual(self.native.exec("PRAGMA user_version"), [["5"]])
        owner = "11111111-1111-4111-8111-111111111111"
        device = "22222222-2222-4222-8222-222222222222"
        self.assertTrue(self.store.bind_account(owner, device))
        self.store.close(); self.store.open()
        self.assertFalse(self.store.bind_account(owner, device))
        self.assertEqual(self.native.exec("SELECT count(*) FROM ps_crud"), [["0"]])
        self.assertEqual(self.native.exec("PRAGMA integrity_check"), [["ok"]])

    def test_unknown_schema_version_stays_unchanged(self):
        self.store.open()
        self.native.exec("PRAGMA user_version=99")
        self.store.close()
        path = Path(self.root) / "state.sqlite"
        original = hashlib.sha256(path.read_bytes()).digest()
        with self.assertRaisesRegex(ValueError, "Unsupported database schema"):
            self.store.open()
        self.assertEqual(hashlib.sha256(path.read_bytes()).digest(), original)

    def test_old_schema_migration_discards_only_authorized_badge_progress(self):
        import json
        for version in (1, 2, 3):
            with self.subTest(version=version):
                self.store.open()
                self.native.exec("DELETE FROM badge_state")
                old = dict(storage.DEFAULTS, water_count=7, stretch_count=4)
                if version == 1: old.pop("clock_saved_s")
                payload = storage._quote(json.dumps(old))
                self.native.exec("INSERT INTO badge_state(id,snapshot) VALUES('current',%s)" % payload)
                if version == 3:
                    self.native.exec("INSERT INTO badge_state(id,snapshot) VALUES('legacy',%s)" % payload)
                    self.store.bind_account("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
                account = self.native.exec("SELECT snapshot FROM badge_state WHERE id='account'")
                self.native.exec("PRAGMA user_version=%s" % version)
                self.store.close(); self.store.open()
                self.assertEqual(self.native.exec("PRAGMA user_version"), [["5"]])
                self.assertEqual(self.native.exec("SELECT count(*) FROM badge_state WHERE id IN ('current','legacy')"), [["0"]])
                self.assertEqual(self.native.exec("SELECT snapshot FROM badge_state WHERE id='account'"), account)
                self.assertEqual(self.native.exec("SELECT count(*) FROM ps_crud"), [["0"]])
                self.assertEqual(self.native.exec("PRAGMA integrity_check"), [["ok"]])

    def test_discard_migration_is_transactional(self):
        import json
        self.store.open()
        payload = storage._quote(json.dumps(storage.DEFAULTS))
        self.native.exec("INSERT INTO badge_state(id,snapshot) VALUES('current',%s)" % payload)
        self.native.exec("INSERT INTO badge_state(id,snapshot) VALUES('legacy',%s)" % payload)
        self.native.exec("PRAGMA user_version=3")
        self.store.close()
        original = self.store._exec
        def interrupted(sql):
            if sql == "PRAGMA user_version=5": raise OSError("migration interrupted")
            return original(sql)
        with patch.object(self.store, "_exec", interrupted), self.assertRaises(OSError):
            self.store.open()
        self.native.open(str(Path(self.root)/"state.sqlite"))
        try:
            self.assertEqual(self.native.exec("SELECT count(*) FROM badge_state WHERE id IN ('current','legacy')"), [["2"]])
            self.assertEqual(self.native.exec("PRAGMA user_version"), [["3"]])
        finally: self.native.close()

    @unittest.skipUnless((ROOT/"badge/dist/backups/state-before-alpha5-20261020.sqlite").exists(), "Live snapshot is local qualification evidence")
    def test_actual_alpha4_backup_migration_preserves_projection_and_core_checkpoints(self):
        import shutil
        source = ROOT/"badge/dist/backups/state-before-alpha5-20261020.sqlite"
        source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
        self.assertEqual(source_hash, "3d50ef0ba677c67db6f1ac0aa4cbe0ffac178d87c652bdec44687d79176bcb4b")
        self.store._owned_directory()
        target = Path(self.root)/"state.sqlite"
        shutil.copyfile(source, target)
        self.native.open(str(target))
        try:
            before = {name: self.native.exec(query) for name, query in {
                "account": "SELECT snapshot FROM badge_state WHERE id='account'",
                "projection": "SELECT id,payload FROM badge_projection ORDER BY id",
                "buckets": "SELECT * FROM ps_buckets ORDER BY name"}.items()}
        finally: self.native.close()
        self.store.open()
        self.assertEqual(self.native.exec("SELECT snapshot FROM badge_state WHERE id='account'"), before["account"])
        self.assertEqual(self.native.exec("SELECT id,payload FROM badge_projection ORDER BY id"), before["projection"])
        self.assertEqual(self.native.exec("SELECT * FROM ps_buckets ORDER BY name"), before["buckets"])
        self.assertEqual(self.native.exec("SELECT count(*) FROM badge_state WHERE id IN ('current','legacy')"), [["0"]])
        self.assertEqual(self.native.exec("SELECT count(*) FROM ps_crud"), [["0"]])
        self.assertEqual(self.native.exec("PRAGMA integrity_check"), [["ok"]])
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), source_hash)

    def test_real_core_checkpoint_publishes_bounded_projection(self):
        import json
        self.store.open()
        instructions = self.store.control("start", {"checkpoint_mode": "requests"})
        self.assertIn("EstablishSyncStream", json.dumps(instructions))
        # Synthetic fixture only: actual transport must seed from the service.
        self.assertEqual(self.store.control("seed_checkpoint_request_id", "9007199254740993"), 9007199254740993)
        self.store.control("line_text", {"checkpoint": {
            "last_op_id": "1", "write_checkpoint": "9007199254740993",
            "buckets": [{"bucket": "bounded-test", "checksum": 1, "priority": 3, "count": 1}]}})
        body = {"id": "summary", "payload": json.dumps({"hydration_count": 5})}
        self.store.control("line_text", {"data": {"bucket": "bounded-test", "has_more": False,
            "after": None, "next_after": "1", "data": [{"op_id": "1", "op": "PUT",
                "object_type": "badge_projection", "object_id": "summary", "checksum": 1, "data": json.dumps(body)}]}})
        completed = self.store.control("line_text", {"checkpoint_complete": {"last_op_id": "1"}})
        self.assertIn("DidCompleteSync", json.dumps(completed))
        self.assertEqual(self.store.projection(), [{"id": "summary", "kind": "summary", "payload": {"hydration_count": 5}}])
        self.store.control("stop")
        self.store.close()
        self.store.open()
        self.assertEqual(self.store.projection()[0]["payload"]["hydration_count"], 5)
        self.assertEqual(self.native.exec("PRAGMA integrity_check"), [["ok"]])
        self.assertEqual(self.native.exec("SELECT count(*) FROM ps_crud"), [["0"]])

    def test_payload_only_upgrade_keeps_offline_cache_and_replaces_old_row_ids(self):
        import json
        owner = "11111111-1111-4111-8111-111111111111"
        device = "22222222-2222-4222-8222-222222222222"
        legacy_schema = json.loads(storage.SCHEMA)
        legacy_schema["tables"][1]["columns"].insert(0, {"name": "kind", "type": "text"})
        self.store.open()
        self.native.exec("BEGIN IMMEDIATE; SELECT powersync_replace_schema(%s); COMMIT" % storage._quote(json.dumps(legacy_schema)))
        self.store.bind_account(owner, device)

        def checkpoint(bucket, key, index, compact):
            self.store.control("line_text", {"checkpoint": {
                "last_op_id": str(index), "write_checkpoint": "9007199254740993",
                "buckets": [{"bucket": bucket, "checksum": index, "priority": 3, "count": 1}]}})
            body = {"id": key, "payload": json.dumps({"hydration_count": index})}
            if not compact:
                body["kind"] = "summary"
            self.store.control("line_text", {"data": {"bucket": bucket, "data": [{
                "op_id": str(index), "op": "PUT", "object_type": "badge_projection",
                "object_id": key, "checksum": index, "data": json.dumps(body)}]}})
            result = self.store.control("line_text", {"checkpoint_complete": {"last_op_id": str(index)}})
            self.assertIn("DidCompleteSync", json.dumps(result))

        self.store.control("start", {"checkpoint_mode": "requests"})
        self.store.control("seed_checkpoint_request_id", "9007199254740993")
        checkpoint("old-stream", owner + ":summary", 1, False)
        self.store.control("stop")
        self.native.exec("PRAGMA user_version=4")
        account = self.native.exec("SELECT snapshot FROM badge_state WHERE id='account'")
        buckets = self.native.exec("SELECT * FROM ps_buckets ORDER BY name")
        self.store.close()
        self.store.open()
        self.assertEqual(self.native.exec("PRAGMA user_version"), [["5"]])
        self.assertEqual([row[1] for row in self.native.exec("PRAGMA table_info(badge_projection)")], ["id", "payload"])
        self.assertEqual(self.native.exec("SELECT snapshot FROM badge_state WHERE id='account'"), account)
        self.assertEqual(self.native.exec("SELECT * FROM ps_buckets ORDER BY name"), buckets)
        self.assertEqual(self.store.projection(), [{"id": owner + ":summary", "kind": "summary",
                                                  "payload": {"hydration_count": 1}}])
        # A new stream checkpoint removes the old bucket and its long ids in the
        # same publish as the compact rows, without an empty/reset database.
        self.store.control("start", {"checkpoint_mode": "requests"})
        checkpoint("compact-stream", "summary", 2, True)
        self.assertEqual(self.store.projection(), [{"id": "summary", "kind": "summary",
                                                  "payload": {"hydration_count": 2}}])
        stored = self.native.exec("SELECT data FROM ps_data__badge_projection")
        self.assertEqual(len(stored), 1)
        self.assertEqual(set(json.loads(stored[0][0])), {"id", "payload"})
        self.assertEqual(json.loads(stored[0][0])["id"], "summary")
        self.store.control("stop")
        self.assertEqual(self.native.exec("PRAGMA integrity_check"), [["ok"]])

    def test_projection_budget_rejects_before_native_write(self):
        self.store.open()
        pages = self.native.exec("PRAGMA page_count")
        with self.assertRaisesRegex(ValueError, "too large"):
            self.store.control("line_text", "x" * 8193)
        with self.assertRaisesRegex(ValueError, "Unexpected synced table"):
            self.store.control("line_text", {"data": {"data": [{"op": "PUT", "object_type": "sessions"}]}})
        with self.assertRaisesRegex(ValueError, "Unexpected sync buckets"):
            self.store.control("line_text", {"checkpoint": {"buckets": [{}] * 5}})
        self.assertEqual(self.native.exec("PRAGMA page_count"), pages)

    def test_unexpected_outbox_is_rejected_before_legacy_migration(self):
        self.store.open()
        self.native.exec("PRAGMA user_version=2")
        self.native.exec("INSERT INTO ps_crud(data) VALUES('{}')")
        self.store.close()
        path = Path(self.root) / "state.sqlite"
        original = hashlib.sha256(path.read_bytes()).digest()
        with self.assertRaisesRegex(ValueError, "Unexpected SQL outbox"):
            self.store.open()
        self.assertEqual(hashlib.sha256(path.read_bytes()).digest(), original)

    def test_extra_legacy_records_are_rejected_before_schema_migration(self):
        self.store.open()
        self.native.exec("INSERT INTO badge_state(id,snapshot) VALUES('unexpected','{}')")
        self.native.exec("PRAGMA user_version=2")
        self.store.close()
        path = Path(self.root) / "state.sqlite"
        original = hashlib.sha256(path.read_bytes()).digest()
        with self.assertRaisesRegex(ValueError, "Unexpected legacy records"):
            self.store.open()
        self.assertEqual(hashlib.sha256(path.read_bytes()).digest(), original)

    def test_authorized_discard_does_not_adopt_invalid_old_snapshot(self):
        self.store.open()
        self.native.exec("INSERT INTO badge_state(id,snapshot) VALUES('current','{}')")
        self.native.exec("PRAGMA user_version=3")
        self.store.close(); self.store.open()
        self.assertEqual(self.native.exec("SELECT count(*) FROM badge_state"), [["0"]])
        self.assertEqual(self.native.exec("PRAGMA user_version"), [["5"]])


@unittest.skipUnless(HOST_LIBRARY.exists(), "Build pinned real-core host qualifier first")
class RealCoreBatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = str(Path(self.temp.name) / "badge")
        self.native = HostCore()
        self.store = storage.Store(native=self.native, root=self.root).open()

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def checkpoint(self, count=12):
        import json
        self.store.control("start", {"checkpoint_mode": "requests"})
        self.store.control("seed_checkpoint_request_id", "9007199254740993")
        self.store.control("line_text", {"checkpoint": {
            "last_op_id": str(count), "write_checkpoint": "9007199254740993",
            "buckets": [{"bucket": "batch-test", "checksum": sum(range(1, count + 1)),
                         "priority": 3, "count": count}]}})
        result = []
        for index in range(count):
            body = {"id": "summary", "payload": json.dumps({"hydration_count": index})}
            result.append(json.dumps({"data": {"bucket": "batch-test", "data": [{
                "op_id": str(index + 1), "op": "PUT", "object_type": "badge_projection",
                "object_id": "summary", "checksum": index + 1, "data": json.dumps(body)}]}}))
        return result

    def test_bad_later_record_rejects_entire_batch_before_native_write(self):
        import json
        records = self.checkpoint(2)
        bad = json.loads(records[1])
        bad["data"]["data"][0]["object_type"] = "sessions"
        before = Path(self.root, "state.sqlite").read_bytes()
        with patch.object(self.store, "_apply_control", wraps=self.store._apply_control) as applied:
            with self.assertRaisesRegex(ValueError, "Unexpected synced table"):
                self.store.control_batch([records[0], json.dumps(bad)])
            applied.assert_not_called()
        self.assertEqual(Path(self.root, "state.sqlite").read_bytes(), before)
        self.assertEqual(self.store._scalar("SELECT count(*) FROM ps_oplog"), "0")

    def test_mismatched_row_id_rejects_entire_batch_before_native_write(self):
        import json
        records = self.checkpoint(2)
        for wrong_id in ("pet", None, 1):
            with self.subTest(wrong_id=wrong_id):
                bad = json.loads(records[1])
                op = bad["data"]["data"][0]
                body = json.loads(op["data"])
                body["id"] = wrong_id
                op["data"] = json.dumps(body)
                before = Path(self.root, "state.sqlite").read_bytes()
                with patch.object(self.store, "_apply_control", wraps=self.store._apply_control) as applied:
                    with self.assertRaisesRegex(ValueError, "Sync row exceeds projection contract"):
                        self.store.control_batch([records[0], json.dumps(bad)])
                    applied.assert_not_called()
                self.assertEqual(Path(self.root, "state.sqlite").read_bytes(), before)
        self.assertEqual(self.store._scalar("SELECT count(*) FROM ps_oplog"), "0")

    def test_batch_limits_reject_before_native_write(self):
        import json
        record = self.checkpoint(1)[0]
        cases = [[], [record] * 7, [" " * 8193],
                 [record, json.dumps({"checkpoint_complete": {"last_op_id": "1"}})],
                 [json.dumps({"data": {"bucket": "batch-test", "data": []}, "checkpoint_complete": {}})]]
        for payloads in cases:
            with self.subTest(payload_count=len(payloads)), \
                 patch.object(self.store, "_apply_control", wraps=self.store._apply_control) as applied:
                with self.assertRaises(ValueError):
                    self.store.control_batch(payloads)
                applied.assert_not_called()
        self.assertEqual(self.store._scalar("SELECT count(*) FROM ps_oplog"), "0")

    def test_later_native_failure_rolls_back_prior_record(self):
        import json
        records = self.checkpoint(2)
        apply = self.store._apply_control
        calls = []
        def interrupted(command, payload):
            calls.append(payload)
            if len(calls) == 2:
                raise OSError("fixture write failure")
            return apply(command, payload)
        with patch.object(self.store, "_apply_control", interrupted):
            with self.assertRaisesRegex(OSError, "fixture write failure"):
                self.store.control_batch(records)
        self.assertEqual(len(calls), 2)
        self.assertEqual(self.store._scalar("SELECT count(*) FROM ps_oplog"), "0")
        self.assertEqual(self.store.projection(), [])
        self.assertEqual(self.store._scalar("PRAGMA integrity_check"), "ok")
        self.store.control("stop")
        self.store.close()
        self.store.open()
        instructions = self.store.control("start", {"checkpoint_mode": "requests"})
        request = next(item["EstablishSyncStream"]["request"] for item in instructions if "EstablishSyncStream" in item)
        self.assertEqual(request["buckets"], [])
        self.store.control("seed_checkpoint_request_id", "9007199254740993")
        self.store.control("line_text", {"checkpoint": {
            "last_op_id": "2", "write_checkpoint": "9007199254740993",
            "buckets": [{"bucket": "batch-test", "checksum": 3, "priority": 3, "count": 2}]}})
        self.store.control_batch(records)
        completed = self.store.control("line_text", {"checkpoint_complete": {"last_op_id": "2"}})
        self.assertIn("DidCompleteSync", json.dumps(completed))
        self.assertEqual(self.store.projection()[0]["payload"], {"hydration_count": 1})
        self.assertEqual(self.store._scalar("PRAGMA integrity_check"), "ok")

    def test_batch_preserves_checkpoint_and_reconnect_cursor(self):
        import json
        records = self.checkpoint(12)
        self.store.control_batch(records[:6])
        self.assertEqual(self.store.projection(), [])
        self.store.control("stop")
        self.store.close()
        self.store.open()
        instructions = self.store.control("start", {"checkpoint_mode": "requests"})
        request = next(item["EstablishSyncStream"]["request"] for item in instructions if "EstablishSyncStream" in item)
        self.assertEqual(request["buckets"], [{"name": "batch-test", "after": "6"}])
        self.store.control("seed_checkpoint_request_id", "9007199254740993")
        self.store.control("line_text", {"checkpoint": {
            "last_op_id": "12", "write_checkpoint": "9007199254740993",
            "buckets": [{"bucket": "batch-test", "checksum": 78, "priority": 3, "count": 12}]}})
        self.store.control_batch(records[6:])
        self.assertEqual(self.store.projection(), [])
        completed = self.store.control("line_text", {"checkpoint_complete": {"last_op_id": "12"}})
        self.assertIn("DidCompleteSync", json.dumps(completed))
        self.assertEqual(self.store.projection()[0]["payload"], {"hydration_count": 11})
        self.assertEqual(self.store._scalar("SELECT count(*) FROM ps_crud"), "0")
        self.assertEqual(self.store._scalar("PRAGMA integrity_check"), "ok")

    def test_batched_history_matches_per_record_with_fewer_transactions(self):
        import json
        # Repeat the same bounded 28-version history with the real core. The
        # counter measures SQL commits, not physical LittleFS writes or timing.
        measurements = []
        for batch_size in (1, 6):
            self.store.close()
            root = str(Path(self.temp.name) / ("run-%s" % batch_size))
            self.store = storage.Store(native=self.native, root=root).open()
            sql = []
            execute = self.store._exec
            def observed(statement):
                sql.append(statement)
                return execute(statement)
            self.store._exec = observed
            records = self.checkpoint(28)
            # Exclude setup/control commits so only the download's two markers
            # and data transactions contribute to the result below.
            sql.clear()
            for offset in range(0, len(records), batch_size):
                selected = records[offset:offset + batch_size]
                if batch_size == 1:
                    self.store.control("line_text", selected[0])
                else:
                    self.store.control_batch(selected)
            completed = self.store.control("line_text", {"checkpoint_complete": {"last_op_id": "28"}})
            self.assertIn("DidCompleteSync", json.dumps(completed))
            measurements.append({"commits": sql.count("COMMIT") + 1,
                "bytes": sum(len(record.encode()) for record in records),
                "projection": self.store.projection(),
                "buckets": self.store._exec("SELECT name,last_op,last_applied_op FROM ps_buckets ORDER BY name"),
                "pages": int(self.store._scalar("PRAGMA page_count"))})
        self.assertEqual([result["commits"] for result in measurements], [30, 7])
        self.assertEqual(measurements[0]["bytes"], measurements[1]["bytes"])
        self.assertEqual(measurements[0]["projection"], measurements[1]["projection"])
        self.assertEqual(measurements[1]["projection"][0]["payload"], {"hydration_count": 27})
        self.assertEqual(measurements[0]["buckets"], measurements[1]["buckets"])
        self.assertLess(measurements[1]["pages"], storage.MAX_SYNC_PAGES)


if __name__ == "__main__":
    unittest.main()
