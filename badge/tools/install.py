"""Install a verified app ZIP into a mounted Badgeware disk, without overwrites.

Defaults to inspection. Use --install after selecting the badge's ordinary USB
disk (double-tap Reset). This tool never talks to the ROM firmware loader.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import tempfile
import zipfile

PREFIX = "apps/badgegotchi/"
MAX_TOTAL = 4 * 1024 * 1024
SAFE_PART = re.compile(r"[A-Za-z0-9_+-][A-Za-z0-9._+-]*\Z")
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
RESERVED = {"CON", "PRN", "AUX", "NUL"} | {
    prefix + str(number) for prefix in ("COM", "LPT") for number in range(1, 10)
}


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate package metadata field")
        result[key] = value
    return result


def read_package(path):
    files = {}
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if not entries or len(entries) > 100 or sum(e.file_size for e in entries) > MAX_TOTAL:
            raise ValueError("App package exceeds size or file-count limits")
        seen = set()
        for entry in entries:
            if not entry.filename.startswith(PREFIX) or entry.is_dir():
                raise ValueError("Package contains an unexpected path")
            name = entry.filename[len(PREFIX):]
            parts = PurePosixPath(name).parts
            if (not name or "\\" in name or "\0" in name or ":" in name
                    or str(PurePosixPath(name)) != name or name.startswith("/")
                    or any(not SAFE_PART.fullmatch(p) or p.endswith(".")
                           or p.split(".")[0].upper() in RESERVED for p in parts)
                    or name.lower() in seen
                    or ((entry.external_attr >> 16) & 0o170000) not in (0, 0o100000)):
                raise ValueError("Unsafe or duplicate package path")
            seen.add(name.lower())
            files[name] = archive.read(entry)
    for name in files:
        if any(str(parent).lower() in seen for parent in PurePosixPath(name).parents
               if str(parent) != "."):
            raise ValueError("Package file conflicts with a directory path")
    try:
        metadata = json.loads(files["badgegotchi-package.json"], object_pairs_hook=_unique_object)
    except (KeyError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("Missing or malformed package metadata") from exc
    if (not isinstance(metadata, dict) or type(metadata.get("schemaVersion")) is not int
            or metadata.get("schemaVersion") != 1 or metadata.get("appId") != "badgegotchi"
            or metadata.get("runtimeMpy") != 7942
            or not isinstance(metadata.get("version"), str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,63}", metadata["version"])
            or not isinstance(metadata.get("files"), list)):
        raise ValueError("Unsupported app metadata")
    listed = set()
    for record in metadata["files"]:
        if (not isinstance(record, dict) or not isinstance(record.get("path"), str)
                or type(record.get("bytes")) is not int or record["bytes"] < 0
                or not isinstance(record.get("sha256"), str)
                or not SHA256.fullmatch(record["sha256"])):
            raise ValueError("Malformed package inventory entry")
        name = record["path"]
        if name in listed:
            raise ValueError("Duplicate package inventory entry")
        listed.add(name)
        if name not in files or name == "badgegotchi-package.json":
            raise ValueError("Package inventory names an unexpected file")
        data = files[name]
        if len(data) != record["bytes"] or hashlib.sha256(data).hexdigest() != record["sha256"]:
            raise ValueError("App file checksum failed: " + name)
    if listed != set(files) - {"badgegotchi-package.json"}:
        raise ValueError("Package has files missing from its inventory")
    if not {"__init__.py", "badgegotchi_native.mpy", "icon.png"}.issubset(files):
        raise ValueError("Incomplete app package")
    native = metadata.get("native")
    data = files["badgegotchi_native.mpy"]
    if (not isinstance(native, dict) or native.get("file") != "badgegotchi_native.mpy"
            or native.get("mpy") != 7942 or type(native.get("bytes")) is not int
            or native["bytes"] != len(data)
            or native.get("sha256") != hashlib.sha256(data).hexdigest()
            or data[:4] != bytes((77, 6, 31, 31))):
        raise ValueError("Native module identity does not match the package")
    return files, metadata


def destination(volume):
    if volume.is_symlink() or not volume.is_dir():
        raise ValueError("Select the mounted Badgeware USB disk")
    if (volume / "INFO_UF2.TXT").exists():
        raise ValueError("This is BOOTSEL. Use Badgeware USB disk mode: double-tap Reset")
    apps = volume / "apps"
    if (apps.is_symlink() or not apps.is_dir() or not (apps / "menu").is_dir()
            or not (volume / "main.py").is_file()):
        raise ValueError("The selected directory is not the supported Badgeware disk root")
    target = apps / "badgegotchi"
    if any(p.name.lower() == "badgegotchi" for p in apps.iterdir()):
        raise ValueError("badgegotchi already exists; refusing to replace an installed app")
    return target


def install(package, volume, write=False):
    files, metadata = read_package(package)
    target = destination(volume)
    # Both the private verified staging tree and final tree coexist briefly.
    if shutil.disk_usage(volume).free < 2 * sum(map(len, files.values())) + 128 * 1024:
        raise ValueError("Insufficient free space on the Badgeware disk")
    if write:
        stage = Path(tempfile.mkdtemp(prefix=".badgegotchi-install-", dir=target.parent))
        created_files = []
        created_dirs = []
        try:
            for name, data in sorted(files.items(), key=lambda item: item[0] == "__init__.py"):
                path = stage / name
                path.parent.mkdir(parents=True, exist_ok=True)
                with path.open("xb") as output:
                    output.write(data)
                    output.flush()
                    os.fsync(output.fileno())
                if path.read_bytes() != data:
                    raise OSError("Readback verification failed: " + name)
            # Reserve the final directory exclusively. POSIX rename alone may
            # replace an empty directory created after the destination check.
            destination(volume)
            target.mkdir()
            created_dirs.append(target)
            # Publish __init__.py last so an interrupted installation cannot
            # start the app before its dependencies have been copied/verified.
            for name, data in sorted(files.items(), key=lambda item: item[0] == "__init__.py"):
                path = target / name
                missing = []
                parent = path.parent
                while parent != target and not parent.exists():
                    missing.append(parent)
                    parent = parent.parent
                for parent in reversed(missing):
                    parent.mkdir()
                    created_dirs.append(parent)
                with path.open("xb") as output:
                    created_files.append(path)
                    output.write((stage / name).read_bytes())
                    output.flush()
                    os.fsync(output.fileno())
                if path.read_bytes() != data:
                    raise OSError("Installed readback verification failed: " + name)
        except BaseException:
            # Only delete files this invocation created. Preserve unexpected
            # additions even if another program writes into the new directory.
            for path in reversed(created_files):
                path.unlink(missing_ok=True)
            for path in reversed(created_dirs):
                try:
                    path.rmdir()
                except OSError:
                    pass
            raise
        finally:
            if stage.exists():
                shutil.rmtree(stage)  # Only this invocation's private staging folder.
    return {"installed": write, "version": metadata["version"],
            "target": str(target), "files": len(files), "bytes": sum(map(len, files.values()))}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", type=Path)
    parser.add_argument("volume", type=Path)
    parser.add_argument("--install", action="store_true")
    args = parser.parse_args()
    print(json.dumps(install(args.package, args.volume, args.install), indent=2))
