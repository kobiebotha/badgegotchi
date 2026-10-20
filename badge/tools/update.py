"""Update an exact known app in Badgeware USB disk mode; retain both backups.

This developer tool does not open the state partition or update firmware.
No other process may copy files into the app directory during an update.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import tempfile
from install import read_package


def verify_tree(root, files):
    found = set()
    for path in root.rglob("*"):
        relative = path.relative_to(root)
        if path.is_symlink():
            raise ValueError("Refusing a symlink in the installed app")
        if path.name.startswith("._"):
            if not path.is_file():
                raise ValueError("Unexpected metadata directory")
            continue  # macOS AppleDouble metadata on FAT.
        if path.is_dir():
            if not any(name.startswith(relative.as_posix() + "/") for name in files):
                raise ValueError("Unexpected directory in the installed app")
            continue
        name = relative.as_posix()
        if name not in files or path.read_bytes() != files[name]:
            raise ValueError("Installed app changed; refusing update: " + name)
        found.add(name)
    if found != set(files):
        raise ValueError("Installed app is incomplete; refusing update")


def update(old_package, new_package, volume, backup=None, write=False):
    old, old_meta = read_package(old_package)
    new, new_meta = read_package(new_package)
    if (volume.is_symlink() or not volume.is_dir() or (volume / "INFO_UF2.TXT").exists()
            or not (volume / "main.py").is_file() or not (volume / "apps/menu").is_dir()
            or (volume / "apps").is_symlink()):
        raise ValueError("Select the supported Badgeware USB disk")
    app = volume / "apps/badgegotchi"
    if app.is_symlink() or not app.is_dir():
        raise ValueError("Expected an existing Badgegotchi app")
    verify_tree(app, old)
    if shutil.disk_usage(volume).free < sum(map(len, new.values())) + 128 * 1024:
        raise ValueError("Insufficient disk space for a staged update")
    result = {"updated": write, "from": old_meta["version"], "to": new_meta["version"]}
    if not write:
        return result
    if backup is None or backup.exists() or backup.is_symlink():
        raise ValueError("Choose a new host backup directory")
    if backup.resolve().is_relative_to(volume.resolve()):
        raise ValueError("The host backup must be outside the badge volume")
    backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(app, backup)
    verify_tree(backup, old)
    container = Path(tempfile.mkdtemp(prefix=".badgegotchi-update-", dir=volume))
    (container / "owner.txt").write_text("badgegotchi-checked-app-update-v1\n")
    stage = container / "next"
    stage.mkdir()
    previous = container / "previous"
    for name, data in sorted(new.items(), key=lambda item: item[0] == "__init__.py"):
        path = stage / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("xb") as target:
            target.write(data)
            target.flush()
            os.fsync(target.fileno())
        if path.read_bytes() != data:
            raise OSError("Staged app readback failed; existing app is unchanged")
    verify_tree(stage, new)
    verify_tree(app, old)
    app.rename(previous)
    try:
        if app.exists():
            raise ValueError("Another writer created the app folder during update")
        stage.rename(app)
    except BaseException:
        if not app.exists():
            previous.rename(app)
        raise
    verify_tree(app, new)
    result.update(host_backup=str(backup), disk_backup=str(previous),
                  files=len(new), bytes=sum(map(len, new.values())))
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("old_package", type=Path)
    parser.add_argument("new_package", type=Path)
    parser.add_argument("volume", type=Path)
    parser.add_argument("--backup", type=Path)
    parser.add_argument("--install", action="store_true")
    args = parser.parse_args()
    print(json.dumps(update(args.old_package, args.new_package, args.volume,
                            args.backup, args.install), indent=2))
