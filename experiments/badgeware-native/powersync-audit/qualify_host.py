#!/usr/bin/env python3
"""Qualify fixture.py against the pinned real core using a host POSIX database."""
import ctypes as c
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent
POWERBADGE = Path(os.environ.get(
    "POWERBADGE_DIR", "/Users/kobie/projects/powersync/skunkworks/powerbadge"))
NATIVE = POWERBADGE / "native"
PS = NATIVE / "sqlite-hello/powersync"
SQLITE = NATIVE / "sqlite-hello/vendor/sqlite-littlefs-vfs/vendor/sqlite"
LIB = ROOT / "build/fixture-host.dylib"

if "--run" not in sys.argv:
    subprocess.run([sys.executable, str(PS / "fetch.py"), "--check"], check=True)
    subprocess.run([sys.executable, str(NATIVE / "sqlite-hello/tools/fetch_storage.py"), "--check"], check=True)
    host = subprocess.check_output(
        ["sh", str(NATIVE / "with-toolchain.sh"), "rustc", "+1.96.0", "-vV"], text=True)
    host = next(line[6:] for line in host.splitlines() if line.startswith("host: "))
    core = PS / "build" / host / "release/libpowersync.a"
    if not core.exists():
        raise SystemExit("Pinned host core archive missing; this qualifier will not build outside its owned directory.")
    LIB.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([
        "cc", "-std=c11", "-O1", "-dynamiclib", "-D_DARWIN_C_SOURCE",
        "-include", str(PS / "networking/host/sqlite_host_config.h"),
        "-I", str(SQLITE), str(SQLITE / "sqlite3.c"), str(ROOT / "host_shim.c"),
        str(core), "-lm", "-o", str(LIB),
    ], check=True)
    # The unmodified core's no_std panic handler loops. Bound the host process.
    subprocess.run([sys.executable, str(__file__), "--run"], check=True, timeout=30)
    raise SystemExit(0)

import fixture

lib = c.CDLL(str(LIB))
for name, restype, args in [
    ("sqlite3_open", c.c_int, [c.c_char_p, c.POINTER(c.c_void_p)]),
    ("sqlite3_close", c.c_int, [c.c_void_p]),
    ("sqlite3_exec", c.c_int, [c.c_void_p, c.c_char_p, c.c_void_p, c.c_void_p, c.c_void_p]),
    ("sqlite3_errmsg", c.c_char_p, [c.c_void_p]),
    ("sqlite3_prepare_v2", c.c_int, [c.c_void_p, c.c_char_p, c.c_int, c.POINTER(c.c_void_p), c.c_void_p]),
    ("sqlite3_step", c.c_int, [c.c_void_p]),
    ("sqlite3_finalize", c.c_int, [c.c_void_p]),
    ("sqlite3_column_type", c.c_int, [c.c_void_p, c.c_int]),
    ("sqlite3_column_int64", c.c_int64, [c.c_void_p, c.c_int]),
    ("sqlite3_column_text", c.c_char_p, [c.c_void_p, c.c_int]),
    ("sqlite3_memory_used", c.c_int64, []),
    ("sqlite3_memory_highwater", c.c_int64, [c.c_int]),
]:
    fn = getattr(lib, name)
    fn.restype, fn.argtypes = restype, args
arena = c.create_string_buffer(256 * 1024)
lib.sqlite3_config.argtypes = [c.c_int]  # Fixed part of Darwin arm64 variadic ABI.
assert lib.sqlite3_config(c.c_int(8), c.cast(arena, c.c_void_p), c.c_int(len(arena)), c.c_int(64)) == 0
assert lib.sqlite3_initialize() == 0
assert lib.fixture_register() == 0
database = c.c_void_p()


def check(rc):
    if rc != 0:
        raise RuntimeError((rc, lib.sqlite3_errmsg(database).decode()))


def execute(sql):
    check(lib.sqlite3_exec(database, sql.encode(), None, None, None))


def scalar(sql):
    statement = c.c_void_p()
    check(lib.sqlite3_prepare_v2(database, sql.encode(), -1, c.byref(statement), None))
    try:
        assert lib.sqlite3_step(statement) == 100, sql
        kind = lib.sqlite3_column_type(statement, 0)
        if kind == 1:
            result = lib.sqlite3_column_int64(statement, 0)
        elif kind == 5:
            result = None
        else:
            result = lib.sqlite3_column_text(statement, 0).decode()
        assert lib.sqlite3_step(statement) == 101, sql
        return result
    finally:
        check(lib.sqlite3_finalize(statement))


with tempfile.TemporaryDirectory(prefix="fixture-", dir=ROOT / "build") as folder:
    path = str(Path(folder) / "powersync.db").encode()
    check(lib.sqlite3_open(path, c.byref(database)))
    print("HOST ONLY:", fixture.fresh(execute, scalar))
    check(lib.sqlite3_close(database))
    check(lib.sqlite3_open(path, c.byref(database)))
    print("HOST ONLY:", fixture.reopened(execute, scalar))
    check(lib.sqlite3_close(database))
peak = lib.sqlite3_memory_highwater(0)
assert lib.sqlite3_shutdown() == 0
assert lib.sqlite3_memory_used() == 0
print("PASS real PowerSync 0.5.4 host fixture, 256 KiB shared SQLite/Rust arena, peak=%d, after_shutdown=0" % peak)
