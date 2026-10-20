#!/usr/bin/env python3
"""Inspect the PIC archive without assuming that it is an importable .mpy."""
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parent
POWERBADGE = Path(os.environ.get(
    "POWERBADGE_DIR", "/Users/kobie/projects/powersync/skunkworks/powerbadge"))
WRAPPER = POWERBADGE / "native/with-toolchain.sh"
TARGET = os.environ.get("POWERSYNC_TARGET", "thumbv8m.main-none-eabi")
ARCHIVE = ROOT / "build" / TARGET / "release/libpowersync.a"
OUT = ROOT / "build/audit"
OUT.mkdir(parents=True, exist_ok=True)


def command(*args):
    return subprocess.check_output(["sh", str(WRAPPER), *args], text=True)


members = command("arm-none-eabi-ar", "t", str(ARCHIVE)).splitlines()
main = next(name for name in members if name.startswith("powersync-"))
main_path = OUT / "powersync-core.o"
main_path.write_bytes(subprocess.check_output(
    ["sh", str(WRAPPER), "arm-none-eabi-ar", "p", str(ARCHIVE), main]))
for tag, flags in (
    ("sections", ["-W", "-S"]),
    ("relocations", ["-W", "-r"]),
    ("attributes", ["-A"]),
    ("symbols", ["-W", "-s"]),
):
    (OUT / (tag + ".txt")).write_text(
        command("arm-none-eabi-readelf", *flags, str(main_path)))
nm = command("arm-none-eabi-nm", "-u", str(main_path))
(OUT / "unresolved-main.txt").write_text(nm)
relocations = (OUT / "relocations.txt").read_text()
sections = []
for line in (OUT / "sections.txt").read_text().splitlines():
    match = re.match(
        r"\s*\[\s*(\d+)\]\s+(\S+)\s+(\S+)\s+[0-9a-f]+\s+[0-9a-f]+\s+([0-9a-f]+)\s+\S+\s+([A-Z]*)",
        line,
    )
    if match:
        _, name, kind, size, flags = match.groups()
        sections.append({"name": name, "type": kind, "bytes": int(size, 16), "flags": flags})
summary = {
    "core_version": "0.5.4",
    "core_commit": "0ed9f4edba418a4f8ae7cb0594da683cd79a81b5",
    "target": TARGET,
    "archive_sha256": hashlib.sha256(ARCHIVE.read_bytes()).hexdigest(),
    "archive_bytes": ARCHIVE.stat().st_size,
    "archive_members": len(members),
    "main_member": main,
    "main_object_sha256": hashlib.sha256(main_path.read_bytes()).hexdigest(),
    "allocated_section_bytes": sum(s["bytes"] for s in sections if "A" in s["flags"]),
    "writable_sections": [s for s in sections if "W" in s["flags"] and s["bytes"]],
    "relocations": dict(sorted(Counter(re.findall(r"\bR_ARM_[A-Z0-9_]+", relocations)).items())),
    "unresolved_main": [line.split()[-1] for line in nm.splitlines() if line.strip()],
    "caveat": "Object/archive inspection only: neither .mpy link success nor device execution.",
}
(OUT / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
display = dict(summary)
display["writable_sections"] = {
    "count": len(summary["writable_sections"]),
    "bytes": sum(s["bytes"] for s in summary["writable_sections"]),
    "prefixes": dict(Counter(
        ".".join(s["name"].split(".")[:4]) for s in summary["writable_sections"])),
}
print(json.dumps(display, indent=2))
