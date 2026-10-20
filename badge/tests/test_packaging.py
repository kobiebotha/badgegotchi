"""Distribution integrity and preservation tests on temporary host volumes."""

import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile


TOOLS = Path(__file__).resolve().parents[1] / "tools"


def load_tool(name):
    spec = importlib.util.spec_from_file_location("badge_" + name, TOOLS / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


package = load_tool("package")
installer = load_tool("install")


def snapshot(root):
    return {str(path.relative_to(root)): ("dir" if path.is_dir() else path.read_bytes(),
                                         path.stat().st_mtime_ns)
            for path in [root, *sorted(root.rglob("*"))]}


class PackagingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.app = self.root / "source"
        self.native = self.root / "native.mpy"
        data = bytes((77, 6, 31, 31)) + b"qualified native fixture"
        self.native.write_bytes(data)
        self.pin = {"file": "badgegotchi_native.mpy", "mpy": 7942,
                    "bytes": len(data), "sha256": package.sha(data)}
        for name in package.SOURCE_FILES:
            path = self.app / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(("source " + name).encode())
        (self.app / "badgegotchi_identity.py").write_text(
            "NATIVE_SHA256 = %r\nNATIVE_BYTES = %r\n" %
            (self.pin["sha256"], self.pin["bytes"]))
        self.files = package.collect_files(self.app, self.native, self.pin)
        self.archive = self.root / "app.zip"
        self.archive.write_bytes(package.make_zip(self.files))
        self.volume = self.root / "volume"
        (self.volume / "apps" / "menu").mkdir(parents=True)
        (self.volume / "main.py").write_text("keep original launcher")
        (self.volume / "apps" / "menu" / "order.txt").write_text("keep menu order")
        (self.volume / "apps" / "other").mkdir()
        (self.volume / "apps" / "other" / "__init__.py").write_text("keep other app")

    def write_files(self, files):
        self.archive.write_bytes(package.make_zip(files))

    def mutate_metadata(self, change):
        files = dict(self.files)
        metadata = json.loads(files["badgegotchi-package.json"])
        change(metadata)
        files["badgegotchi-package.json"] = package.json_bytes(metadata)
        self.write_files(files)

    def test_zip_is_deterministic_and_whitelisted(self):
        first = package.make_zip(self.files)
        for path in self.app.rglob("*"):
            if path.is_file():
                os.utime(path, (123456789, 123456789))
        (self.app / ".env").write_text("MUST NOT SHIP")
        (self.app / "user-state.db").write_bytes(b"MUST NOT SHIP")
        second = package.make_zip(package.collect_files(self.app, self.native, self.pin))
        self.assertEqual(first, second)
        self.assertEqual(first, package.make_zip(dict(reversed(list(self.files.items())))))
        with zipfile.ZipFile(io.BytesIO(first)) as archive:
            self.assertEqual(archive.namelist(), sorted(archive.namelist()))
            self.assertTrue(all(entry.date_time == (2026, 1, 1, 0, 0, 0)
                                for entry in archive.infolist()))
            self.assertNotIn("apps/badgegotchi/.env", archive.namelist())
            self.assertNotIn("apps/badgegotchi/user-state.db", archive.namelist())

    def test_native_mismatch_header_and_stale_app_identity_are_rejected(self):
        wrong = dict(self.pin, sha256="0" * 64)
        with self.assertRaisesRegex(ValueError, "reviewed build identity"):
            package.collect_files(self.app, self.native, wrong)
        bad = b"NOPE" + b"incompatible native fixture"
        self.native.write_bytes(bad)
        wrong = dict(self.pin, bytes=len(bad), sha256=package.sha(bad))
        with self.assertRaisesRegex(ValueError, "incompatible MicroPython header"):
            package.collect_files(self.app, self.native, wrong)
        self.native.write_bytes(bytes((77, 6, 31, 31)) + b"another native fixture")
        wrong = dict(self.pin, bytes=self.native.stat().st_size,
                     sha256=package.sha(self.native.read_bytes()))
        with self.assertRaisesRegex(ValueError, "App native identity"):
            package.collect_files(self.app, self.native, wrong)

    def test_symlinked_source_directory_is_not_packaged(self):
        assets = self.app / "assets"
        moved = self.root / "private-assets"
        assets.rename(moved)
        assets.symlink_to(moved, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symlinked app source"):
            package.collect_files(self.app, self.native, self.pin)

    def test_malicious_paths_are_rejected_without_volume_mutation(self):
        before = snapshot(self.volume)
        for name in ("../main.py", "assets/../../main.py", "/absolute.py",
                     "assets\\outside.py", "assets//thing.py", "assets/.hidden",
                     "assets/trailing.", "CON.txt", "file:stream"):
            with self.subTest(path=name):
                files = dict(self.files, **{name: b"malicious"})
                self.write_files(files)
                with self.assertRaises(ValueError):
                    installer.install(self.archive, self.volume, write=True)
                self.assertEqual(snapshot(self.volume), before)

    def test_duplicate_case_collisions_symlinks_and_nonapp_paths_rejected(self):
        for name, attrs in (("apps/badgegotchi/icon.png", 0),
                            ("apps/badgegotchi/ICON.PNG", 0),
                            ("apps/badgegotchi/link.py", 0o120777 << 16),
                            ("main.py", 0)):
            with self.subTest(path=name, attrs=attrs):
                buffer = io.BytesIO(package.make_zip(self.files))
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", UserWarning)
                    with zipfile.ZipFile(buffer, "a") as archive:
                        info = zipfile.ZipInfo(name)
                        info.external_attr = attrs
                        archive.writestr(info, b"outside")
                self.archive.write_bytes(buffer.getvalue())
                with self.assertRaises(ValueError):
                    installer.read_package(self.archive)

    def test_file_directory_conflict_rejected_before_installation(self):
        self.write_files(dict(self.files, assets=b"file conflicts with asset folder"))
        with self.assertRaisesRegex(ValueError, "conflicts with a directory"):
            installer.read_package(self.archive)

    def test_tampered_content_and_manifest_are_rejected(self):
        files = dict(self.files)
        files["__init__.py"] += b" tampered"
        self.write_files(files)
        with self.assertRaisesRegex(ValueError, "checksum"):
            installer.read_package(self.archive)
        mutations = (
            lambda m: m["files"][0].update(sha256="0" * 64),
            lambda m: m["files"].pop(),
            lambda m: m["files"].append(dict(m["files"][0])),
            lambda m: m["native"].update(sha256="0" * 64),
            lambda m: m.update(runtimeMpy=0),
            lambda m: m.update(files=None),
            lambda m: m["files"][0].update(bytes=True),
            lambda m: m["files"][0].update(path="missing.py"),
        )
        for mutate in mutations:
            self.mutate_metadata(mutate)
            with self.assertRaises(ValueError):
                installer.read_package(self.archive)

    def test_duplicate_json_fields_rejected(self):
        files = dict(self.files)
        files["badgegotchi-package.json"] = b'{"schemaVersion":1,"schemaVersion":1}'
        self.write_files(files)
        with self.assertRaisesRegex(ValueError, "Duplicate package metadata"):
            installer.read_package(self.archive)

    def test_existing_app_is_refused_and_unchanged(self):
        existing = self.volume / "apps" / "BadgeGotchi"
        existing.mkdir()
        (existing / "private.txt").write_bytes(b"existing saved files")
        before = snapshot(self.volume)
        for write in (False, True):
            with self.assertRaisesRegex(ValueError, "already exists"):
                installer.install(self.archive, self.volume, write)
            self.assertEqual(snapshot(self.volume), before)

    def test_dry_run_performs_zero_volume_mutations(self):
        before = snapshot(self.volume)
        result = installer.install(self.archive, self.volume)
        self.assertFalse(result["installed"])
        self.assertEqual(snapshot(self.volume), before)

    def test_successful_install_verifies_all_content_and_preserves_other_apps(self):
        unrelated = {path: path.read_bytes() for path in self.volume.rglob("*") if path.is_file()}
        result = installer.install(self.archive, self.volume, write=True)
        self.assertTrue(result["installed"])
        target = self.volume / "apps" / "badgegotchi"
        self.assertEqual({str(path.relative_to(target)): path.read_bytes()
                          for path in target.rglob("*") if path.is_file()}, self.files)
        self.assertEqual({path: path.read_bytes() for path in unrelated}, unrelated)
        self.assertFalse(list((self.volume / "apps").glob(".badgegotchi-install-*")))

    def test_final_readback_failure_cleans_only_its_new_app(self):
        original = Path.read_bytes
        target = self.volume / "apps" / "badgegotchi"

        def corrupt_readback(path):
            data = original(path)
            if path == target / "icon.png":
                return data + b"corrupt"
            return data

        unrelated = {path: path.read_bytes() for path in self.volume.rglob("*") if path.is_file()}
        with patch.object(Path, "read_bytes", corrupt_readback):
            with self.assertRaisesRegex(OSError, "Installed readback"):
                installer.install(self.archive, self.volume, write=True)
        self.assertFalse(target.exists())
        self.assertEqual({path: path.read_bytes() for path in unrelated}, unrelated)
        self.assertFalse(list((self.volume / "apps").glob(".badgegotchi-install-*")))

    def test_app_appearing_before_publication_is_not_replaced(self):
        original = installer.destination
        calls = [0]
        target = self.volume / "apps" / "badgegotchi"

        def concurrent_app(volume):
            calls[0] += 1
            if calls[0] == 2:
                target.mkdir()
                (target / "keep.txt").write_text("created by someone else")
            return original(volume)

        with patch.object(installer, "destination", concurrent_app):
            with self.assertRaisesRegex(ValueError, "already exists"):
                installer.install(self.archive, self.volume, write=True)
        self.assertEqual((target / "keep.txt").read_text(), "created by someone else")
        self.assertEqual(list(target.iterdir()), [target / "keep.txt"])

    def test_bootsel_wrong_disk_and_low_space_do_not_mutate(self):
        (self.volume / "INFO_UF2.TXT").write_text("ROM loader")
        before = snapshot(self.volume)
        with self.assertRaisesRegex(ValueError, "BOOTSEL"):
            installer.install(self.archive, self.volume, True)
        self.assertEqual(snapshot(self.volume), before)
        (self.volume / "INFO_UF2.TXT").unlink()
        before = snapshot(self.volume)
        with patch.object(installer.shutil, "disk_usage", return_value=type("Space", (), {"free": 1})()):
            with self.assertRaisesRegex(ValueError, "Insufficient"):
                installer.install(self.archive, self.volume, True)
        self.assertEqual(snapshot(self.volume), before)


if __name__ == "__main__":
    unittest.main()
