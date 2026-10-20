"""Compare before/after installation inventories without opening badge files."""
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1] / "evidence"


def load(name):
    return {item[0]: item[1:] for line in (root / name).read_text().splitlines()
            if line.startswith("FILE ") for item in [json.loads(line[5:]) ]}


before, after = load("device-before.txt"), load("device-after.txt")
protected = {path: value for path, value in before.items()
             if not path.startswith("/system/.fseventsd/") and path != "/state/loading.log"}
result = {
    "before_count": len(before), "after_count": len(after),
    "protected_existing_count": len(protected),
    "protected_existing_hashes": sum(item[1] is not None for item in protected.values()),
    "added": sorted(after.keys() - before.keys()),
    "removed": sorted(before.keys() - after.keys()),
    "changed": {name: {"before": before[name], "after": after[name]}
                for name in sorted(before.keys() & after.keys()) if before[name] != after[name]},
}
assert all(after.get(path) == value for path, value in protected.items()), "Existing app/data changed"
assert all(path.startswith("/system/.fseventsd/") for path in result["removed"])
assert set(result["changed"]) <= {"/state/loading.log"}
assert all(path.startswith(("/system/apps/badgegotchi/", "/state/badgegotchi/"))
           or path == "/system/apps/._badgegotchi" for path in result["added"])
result["preservation_pass"] = True
(root / "preservation.json").write_text(json.dumps(result, indent=2) + "\n")
print("PRESERVATION_PASS", result["protected_existing_count"], "existing files;",
      result["protected_existing_hashes"], "hashed app/asset/library files")
