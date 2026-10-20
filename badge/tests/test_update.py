"""Checked app updates preserve existing files and retain rollback copies."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import package
import update


def fixture(path, version):
    native = b"M\x06\x1f\x1fTEST"
    files = {"__init__.py": version.encode(), "icon.png": b"icon", "badgegotchi_native.mpy": native}
    metadata = {"schemaVersion": 1, "appId": "badgegotchi", "runtimeMpy": 7942,
                "version": version, "native": {"file": "badgegotchi_native.mpy",
                    "mpy": 7942, "bytes": len(native), "sha256": hashlib.sha256(native).hexdigest()},
                "files": [{"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                          for name, data in files.items()]}
    files["badgegotchi-package.json"] = json.dumps(metadata).encode()
    path.write_bytes(package.make_zip(files))
    return files


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.volume = self.root / "volume"
        self.app = self.volume / "apps/badgegotchi"
        self.app.mkdir(parents=True)
        (self.volume / "apps/menu").mkdir()
        (self.volume / "main.py").write_bytes(b"firmware launcher")
        (self.volume / "apps/keep.py").write_bytes(b"user app")
        self.old_zip, self.new_zip = self.root / "old.zip", self.root / "new.zip"
        self.old = fixture(self.old_zip, "0.1.0-alpha.1")
        self.new = fixture(self.new_zip, "0.1.0-alpha.2")
        for name, data in self.old.items():
            (self.app / name).write_bytes(data)
        (self.app / "._icon.png").write_bytes(b"metadata")
        self.backup = self.root / "host-backup"

    def tearDown(self):
        self.temp.cleanup()

    def run_update(self, write=True):
        return update.update(self.old_zip, self.new_zip, self.volume, self.backup, write)

    def test_dry_run_changes_nothing(self):
        before = sorted(str(p.relative_to(self.root)) for p in self.root.rglob("*"))
        self.assertFalse(self.run_update(False)["updated"])
        self.assertEqual(sorted(str(p.relative_to(self.root)) for p in self.root.rglob("*")), before)

    def test_success_retains_previous_bytes_and_other_apps(self):
        result = self.run_update()
        update.verify_tree(self.app, self.new)
        update.verify_tree(self.backup, self.old)
        update.verify_tree(Path(result["disk_backup"]), self.old)
        self.assertEqual((self.backup / "._icon.png").read_bytes(), b"metadata")
        self.assertEqual((self.volume / "main.py").read_bytes(), b"firmware launcher")
        self.assertEqual((self.volume / "apps/keep.py").read_bytes(), b"user app")

    def test_changed_app_refused_without_backup_or_mutation(self):
        (self.app / "__init__.py").write_bytes(b"user modification")
        with self.assertRaisesRegex(ValueError, "Installed app changed"):
            self.run_update()
        self.assertFalse(self.backup.exists())
        self.assertEqual((self.app / "__init__.py").read_bytes(), b"user modification")

    def test_failed_staging_keeps_previous_app(self):
        original = update.verify_tree
        def verify(root, files):
            if root.name == "next":
                raise OSError("injected readback failure")
            return original(root, files)
        with patch.object(update, "verify_tree", verify), self.assertRaises(OSError):
            self.run_update()
        update.verify_tree(self.app, self.old)
        update.verify_tree(self.backup, self.old)

    def test_failed_publication_restores_previous_app(self):
        original = Path.rename
        def rename(path, destination):
            if path.name == "next":
                raise OSError("injected rename failure")
            return original(path, destination)
        with patch.object(Path, "rename", rename), self.assertRaises(OSError):
            self.run_update()
        update.verify_tree(self.app, self.old)
        update.verify_tree(self.backup, self.old)


if __name__ == "__main__":
    unittest.main()
