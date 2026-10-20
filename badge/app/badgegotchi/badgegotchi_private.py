"""Bounded, owner-marked private files; never stored in the USB app directory."""
import json
import os

ROOT = "/state/badgegotchi-pairing"
OWNER = "badgegotchi-private-pairing-v1\n"
MAX_BYTES = 12288


def stat(path):
    try:
        return os.stat(path)
    except OSError as exc:
        if exc.args[0] != 2:
            raise
        return None


def secret(value):
    return isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value)


def validate_pairing(value):
    if not isinstance(value, dict) or value.get("state") not in ("unpaired", "pending", "paired"):
        raise ValueError("Unsupported pairing state; retained")
    allowed = {"state", "credential", "pending_secret", "code", "claim_id", "verification_id",
               "approved", "device_id", "owner_id"}
    if set(value) - allowed:
        raise ValueError("Unsupported pairing fields")
    if value["state"] == "unpaired":
        if set(value) != {"state"}:
            raise ValueError("Invalid unpaired state")
        return value
    if not secret(value.get("credential")):
        raise ValueError("Invalid saved device credential")
    if value["state"] == "pending":
        if not secret(value.get("pending_secret")) or value["pending_secret"] == value["credential"]:
            raise ValueError("Invalid saved enrollment secret")
        code = value.get("code")
        if not isinstance(code, str) or len(code) != 12 or any(c not in "ABC" for c in code):
            raise ValueError("Invalid saved enrollment code")
    for key in ("device_id", "owner_id", "claim_id", "verification_id"):
        if key in value and (not isinstance(value[key], str) or not 1 <= len(value[key]) <= 64):
            raise ValueError("Invalid saved identity")
    if value["state"] == "paired" and (not value.get("device_id") or not value.get("owner_id")):
        raise ValueError("Missing saved device identity")
    if "approved" in value and type(value["approved"]) is not bool:
        raise ValueError("Invalid enrollment approval")
    return value


class PrivateFile:
    def __init__(self, name, default, validator, root=ROOT):
        if name not in ("pairing.json", "events.json"):
            raise ValueError("Unknown private file")
        if not root.startswith("/") or root.endswith("/") or "/../" in root:
            raise ValueError("Private data needs an absolute owned directory")
        self.root, self.name, self.default, self.validator = root, name, default, validator

    def _owned(self):
        marker = self.root + "/owner.txt"
        if stat(self.root) is None:
            parent = self.root.rsplit("/", 1)[0]
            capacity = os.statvfs(parent)
            if capacity[1] * capacity[4] < 65536:
                raise OSError("Private storage is full")
            os.mkdir(self.root)
            with open(marker, "x") as target:
                target.write(OWNER)
                target.flush()
            os.sync()
        else:
            if stat(marker) is None:
                raise ValueError("Private directory has no owner marker; retained")
            with open(marker) as source:
                if source.read(128) != OWNER:
                    raise ValueError("Private directory belongs to another app")
        allowed = ("owner.txt", "pairing.json", "pairing.json.next", "events.json", "events.json.next")
        for name in os.listdir(self.root):
            if name not in allowed or os.stat(self.root + "/" + name)[0] & 0xf000 != 0x8000:
                raise ValueError("Unrecognized private data; retained")

    def load(self):
        self._owned()
        path = self.root + "/" + self.name
        info = stat(path)
        if info is None:
            # A first save interrupted before rename was never sent to a server.
            # Keep the file until a successful new save replaces it.
            return dict(self.default)
        if not 0 < info[6] <= MAX_BYTES:
            raise ValueError("Invalid private file size; retained")
        with open(path) as source:
            return self.validator(json.loads(source.read(MAX_BYTES + 1)))

    def save(self, value):
        self.validator(value)
        encoded = json.dumps(value)
        if len(encoded.encode()) > MAX_BYTES:
            raise ValueError("Private queue is full")
        self._owned()
        path = self.root + "/" + self.name
        pending = path + ".next"
        with open(pending, "w") as target:
            if target.write(encoded) != len(encoded):
                raise OSError("Incomplete private write")
            target.flush()
        os.sync()
        # LittleFS rename atomically publishes a fully synced record. If rename
        # fails, the previous authority remains; never remove it first.
        os.rename(pending, path)
        os.sync()


def pairing_file(root=ROOT):
    return PrivateFile("pairing.json", {"state": "unpaired"}, validate_pairing, root)
