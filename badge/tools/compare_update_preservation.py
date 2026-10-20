"""Compare the alpha.1/alpha.2 inventories, allowing only the recorded update."""
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1] / "evidence"


def load(name):
    content = (root / name).read_text()
    assert "INSPECT_COMPLETE" in content, "Inventory is incomplete"
    return {item[0]: item[1:] for line in content.splitlines()
            if line.startswith("FILE ") for item in [json.loads(line[5:])]}


before = load("device-after.txt")
after = load("device-after-alpha2.txt")
record = json.loads((root / "update-alpha2.txt").read_text())
container = Path(record["disk_backup"]).parent.name
assert container.startswith(".badgegotchi-update-")
protected = {path: value for path, value in before.items()
             if not path.startswith(("/system/apps/badgegotchi/", "/state/badgegotchi/",
                                     "/system/.fseventsd/"))
             and path not in ("/state/loading.log", "/system/apps/._badgegotchi")}
result = {
    "before_count": len(before), "after_count": len(after),
    "protected_existing_count": len(protected),
    "protected_existing_hashes": sum(item[1] is not None for item in protected.values()),
    "added": sorted(after.keys() - before.keys()),
    "removed": sorted(before.keys() - after.keys()),
    "changed": {name: {"before": before[name], "after": after[name]}
                for name in sorted(before.keys() & after.keys()) if before[name] != after[name]},
}
assert all(after.get(path) == value for path, value in protected.items()), "Other app/data changed"
assert not result["removed"], "Unexpected file removal"
assert all(path.startswith(("/system/" + container + "/", "/system/.fseventsd/"))
           or path == "/system/._" + container for path in result["added"])
assert all(path.startswith(("/system/apps/badgegotchi/", "/state/badgegotchi/"))
           or path in ("/state/loading.log", "/system/apps/._badgegotchi")
           for path in result["changed"])
result["preservation_pass"] = True
(root / "preservation-alpha2.json").write_text(json.dumps(result, indent=2) + "\n")
print("PRESERVATION_PASS", len(protected), "existing files;",
      result["protected_existing_hashes"], "hashed app/asset/library files")
