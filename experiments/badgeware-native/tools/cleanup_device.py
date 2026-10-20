"""Explicit optional cleanup, only after all experiment databases are closed."""
import os

ROOT = "/state/badgegotchi-feasibility"
OWNER = "badgegotchi-native-feasibility-2026-10-20-v1\n"
ALLOWED = {
    "owner.txt",
    "probe-sqlite-v1.db",
    "probe-powersync-v1.db",
    "probe-powersync-v1.db-journal",
    "probe-powersync-v2.db",
    "probe-powersync-v2.db-journal",
    "probe-truncate-v1.db",
    "probe-truncate-v1.db-journal",
}
with open(ROOT + "/owner.txt") as source:
    assert source.read() == OWNER, "Ownership marker mismatch"
names = set(os.listdir(ROOT))
assert names <= ALLOWED, ("Unexpected files; refusing cleanup", names - ALLOWED)
for name in names:
    assert not (os.stat(ROOT + "/" + name)[0] & 0x4000), "Unexpected subdirectory"
for name in sorted(names - {"owner.txt"}):
    os.remove(ROOT + "/" + name)
    print("REMOVED", name)
os.remove(ROOT + "/owner.txt")
os.rmdir(ROOT)
os.sync()
print("OWNED_TEST_DIRECTORY_REMOVED")
