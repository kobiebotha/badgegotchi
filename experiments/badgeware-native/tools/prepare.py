#!/usr/bin/env python3
"""Fetch only pinned build inputs into this experiment; never access a device."""
import hashlib
import subprocess
import sys
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "vendor"
REV = "41d1e007537f9b15cf13a9436228dd59d6485eca"
ARCHIVE_SHA256 = "78e2a572f6048c80d1fbd65aa9149127eb145b42c54264c4d20580f838f03821"
VENDOR.mkdir(exist_ok=True)
archive = VENDOR / "micropython.tar.gz"
if not archive.exists():
    with urllib.request.urlopen(
        "https://codeload.github.com/pimoroni/micropython/tar.gz/" + REV
    ) as response:
        archive.write_bytes(response.read())
assert hashlib.sha256(archive.read_bytes()).hexdigest() == ARCHIVE_SHA256
if not (VENDOR / ("micropython-" + REV)).exists():
    with tarfile.open(archive) as source:
        source.extractall(VENDOR, filter="data")
subprocess.run([
    sys.executable, "-m", "pip", "install", "--target", str(VENDOR / "python"),
    "pyelftools==0.32", "ar==1.0.1",
], check=True)
print("Prepared pinned native-module build dependencies; no device operations.")
