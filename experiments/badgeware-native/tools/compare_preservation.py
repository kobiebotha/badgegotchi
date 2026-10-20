#!/usr/bin/env python3
"""Compare read-only device inventories without reading settings contents."""
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1] / "evidence"


def load(name):
    return {
        item[0]: item[1:]
        for line in (root / name).read_text().splitlines()
        if line.startswith("FILE ")
        for item in [json.loads(line[5:])]
    }


before, after = load("device-before.txt"), load("device-after.txt")
result = {
    "before_count": len(before),
    "after_count": len(after),
    "hashed_app_asset_files": sum(item[1] is not None for item in before.values()),
    "added": sorted(after.keys() - before.keys()),
    "removed": sorted(before.keys() - after.keys()),
    "changed": {
        name: {"before": before[name], "after": after[name]}
        for name in sorted(before.keys() & after.keys())
        if before[name] != after[name]
    },
}
(root / "preservation.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result, indent=2))
assert not result["added"] and not result["removed"]
assert set(result["changed"]) <= {"/state/loading.log"}
