"""Build the Badgeware app ZIP and matching static web release, never firmware.

Only explicitly listed application files enter the package. Neither an existing
device filesystem nor a general build directory is a release source.
"""
import argparse
import ast
import hashlib
import io
import json
from pathlib import Path
import zipfile

BADGE = Path(__file__).resolve().parents[1]
REPO = BADGE.parent
VERSION = "0.1.0-alpha.3"
APP_ID = "badgegotchi"
SOURCE_FILES = (
    "__init__.py", "badgegotchi_state.py", "badgegotchi_view.py",
    "badgegotchi_storage.py", "badgegotchi_runtime.py", "badgegotchi_identity.py", "icon.png",
    "badgegotchi_client.py", "badgegotchi_config.py", "badgegotchi_entropy.py",
    "badgegotchi_http.py", "badgegotchi_pairing.py", "badgegotchi_private.py",
    "badgegotchi_sync.py", "ca/sectigo-r46.der",
    "assets/capybara.png", "README.md", "THIRD_PARTY_NOTICES.txt",
    "licenses/PowerSync-Apache-2.0.txt", "licenses/PowerSync-NOTICE.txt",
    "licenses/MicroPython-MIT.txt", "licenses/Badgegotchi-CC0.txt",
    "licenses/Rust-dependencies.txt", "licenses/Compiler-runtime.txt", "licenses/Newlib.txt",
)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()


def collect_files(app, native, pin):
    if native.is_symlink() or not native.is_file():
        raise ValueError("Missing or symlinked native module")
    data = native.read_bytes()
    if len(data) != pin["bytes"] or sha(data) != pin["sha256"]:
        raise ValueError("Native module does not match its reviewed build identity")
    if data[:4] != bytes((77, 6, 31, 31)) or pin["mpy"] != 7942:
        raise ValueError("Native module has an incompatible MicroPython header")
    files = {}
    for name in SOURCE_FILES:
        path = app / name
        ancestors = [app]
        for part in Path(name).parts:
            ancestors.append(ancestors[-1] / part)
        if any(part.is_symlink() for part in ancestors) or not path.is_file():
            raise ValueError("Missing or symlinked app source: " + name)
        files[name] = path.read_bytes()
    identity = {}
    for node in ast.parse(files["badgegotchi_identity.py"]).body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            identity[node.targets[0].id] = ast.literal_eval(node.value)
    if identity.get("NATIVE_SHA256") != pin["sha256"] or identity.get("NATIVE_BYTES") != pin["bytes"]:
        raise ValueError("App native identity does not match its reviewed build")
    files["badgegotchi_native.mpy"] = data
    files["badgegotchi-package.json"] = json_bytes({
        "schemaVersion": 1, "appId": APP_ID, "version": VERSION,
        "runtimeMpy": 7942, "native": pin,
        "files": [{"path": name, "bytes": len(content), "sha256": sha(content)}
                  for name, content in sorted(files.items())],
    })
    return files


def make_zip(files):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(files.items()):
            entry = zipfile.ZipInfo("apps/" + APP_ID + "/" + name, (2026, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, data)
    return output.getvalue()


def write_same_or_new(path, data):
    """Content-addressed web files are immutable once created."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if path.read_bytes() != data:
            raise ValueError("Refusing to replace different release bytes: " + str(path))
    else:
        with path.open("xb") as target:
            target.write(data)


def build(app=BADGE / "app" / APP_ID, native=None, output=BADGE / "dist", web=None):
    pin = json.loads((BADGE / "native" / "module.json").read_text())
    native = native or BADGE / "native" / pin["file"]
    files = collect_files(app, native, pin)
    archive = make_zip(files)
    digest = sha(archive)
    release_id = VERSION + "-" + digest[:12]
    filename = "badgegotchi-" + release_id + ".zip"
    output.mkdir(parents=True, exist_ok=True)
    write_same_or_new(output / filename, archive)
    # Separate versioned tree: no recursive copy, merging, or stale source files.
    for name, data in files.items():
        write_same_or_new(output / release_id / "apps" / APP_ID / name, data)
    base = "/badge-app/" + release_id
    release = {
        "version": VERSION, "appId": APP_ID, "name": "Badgegotchi",
        "board": "tufty2350", "runtimeMpy": 7942,
        "description": "Pair once with the web app using A/B/C, then reconnect to sync account wellness and current account data. Timer remains local. Requires the reviewed Badgeware 1.29.0 runtime and activated badge gateway. Candidate awaits live qualification.",
        "zipUrl": base + "/" + filename, "zipSha256": digest, "zipBytes": len(archive),
        "files": [{"path": name, "url": base + "/files/" + name,
                   "bytes": len(data), "sha256": sha(data)}
                  for name, data in sorted(files.items())],
    }
    manifest = json_bytes({"schemaVersion": 1, "release": release})
    (output / "manifest.json").write_bytes(manifest)
    if web is not None:
        for name, data in files.items():
            write_same_or_new(web / release_id / "files" / name, data)
        write_same_or_new(web / release_id / filename, archive)
        temporary = web / "manifest.json.tmp"
        temporary.write_bytes(manifest)
        temporary.replace(web / "manifest.json")
    print(json.dumps({"zip": str(output / filename), "sha256": digest,
                      "bytes": len(archive), "files": len(files)}, indent=2))
    return release


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native", type=Path)
    parser.add_argument("--output", type=Path, default=BADGE / "dist")
    parser.add_argument("--stage-web", action="store_true")
    args = parser.parse_args()
    build(native=args.native, output=args.output,
          web=REPO / "web" / "public" / "badge-app" if args.stage_web else None)
