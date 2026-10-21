"""Bounded account commands, durable before acknowledgement or optimistic UI."""
import json
import time
from badgegotchi_private import PrivateFile

MAX_COMMANDS = 16
TIMER_COMMANDS = ("timer_start", "timer_pause", "timer_resume", "timer_complete", "timer_stop")


def identifier(value):
    return (isinstance(value, str) and len(value) == 36 and
            all(c in "0123456789abcdef-" for c in value.lower()))


def revision(value):
    return (isinstance(value, str) and 1 <= len(value) <= 19 and value.isdigit()
            and str(int(value)) == value and int(value) < 9223372036854775807)


def stamp(unix_seconds):
    if type(unix_seconds) is not int:
        raise ValueError("Set the badge clock before saving account activity.")
    epoch = 946684800 if time.gmtime(0)[0] == 2000 else 0
    parts = time.gmtime(unix_seconds - epoch)
    if not 2024 <= parts[0] < 2100:
        raise ValueError("Set the badge clock before saving account activity.")
    return "%04d-%02d-%02dT%02d:%02d:%02dZ" % parts[:6]


def validate_command(value):
    base = {"id", "type", "occurred_at"}
    if not isinstance(value, dict) or not identifier(value.get("id")):
        raise ValueError("Invalid saved account command")
    kind = value.get("type")
    extra = set()
    if kind == "pet":
        extra = {"pet_session_id"}
    elif kind == "timer_start":
        extra = {"new_session_id", "session_type", "expected_revision"}
    elif kind in TIMER_COMMANDS:
        extra = {"session_id", "expected_revision"}
    elif kind not in ("hydration", "movement"):
        raise ValueError("Unsupported account command")
    if set(value) != base | extra:
        raise ValueError("Invalid saved command fields")
    when = value["occurred_at"]
    if not isinstance(when, str) or len(when) != 20 or when[-1] != "Z":
        raise ValueError("Invalid command timestamp")
    for key in ("pet_session_id", "session_id", "new_session_id"):
        if key in value and not identifier(value[key]):
            raise ValueError("Invalid command target")
    if "expected_revision" in value and not revision(value["expected_revision"]):
        raise ValueError("Invalid timer revision")
    if "session_type" in value and value["session_type"] not in ("focus", "break"):
        raise ValueError("Invalid timer phase")
    return value


def validate_commands(value):
    if (not isinstance(value, dict) or set(value) != {"version", "owner_id", "device_id", "commands", "awaiting", "notice"}
            or value["version"] != 1 or not isinstance(value["commands"], list)
            or not isinstance(value["awaiting"], list)
            or len(value["commands"]) + len(value["awaiting"]) > MAX_COMMANDS):
        raise ValueError("Unsupported saved account queue")
    ids = set()
    for command in value["awaiting"] + value["commands"]:
        validate_command(command)
        if command["id"] in ids:
            raise ValueError("Duplicate saved account command")
        ids.add(command["id"])
    if not isinstance(value["notice"], str) or len(value["notice"]) > 160:
        raise ValueError("Invalid account queue notice")
    return value


class CommandQueue:
    def __init__(self, identity, entropy, persistence=None):
        self.entropy = entropy
        default = {"version": 1, "owner_id": identity["owner_id"], "device_id": identity["device_id"],
                   "commands": [], "awaiting": [], "notice": ""}
        self.persistence = persistence or PrivateFile("commands.json", default, validate_commands)
        self.record = self.persistence.load()
        validate_commands(self.record)
        if self.record["owner_id"] != identity["owner_id"] or self.record["device_id"] != identity["device_id"]:
            raise ValueError("Another account's commands are retained")

    @property
    def count(self):
        return len(self.record["commands"])

    @property
    def pending_count(self):
        return self.count + len(self.record["awaiting"])

    @property
    def optimistic(self):
        return self.record["awaiting"] + self.record["commands"]

    @property
    def notice(self):
        return self.record["notice"]

    def _save(self, value):
        self.persistence.save(value)
        self.record = value

    def append(self, kind, unix_seconds, **fields):
        from badgegotchi_sync import uuid
        if self.pending_count >= MAX_COMMANDS:
            raise ValueError("Account queue full. Connect before adding more.")
        command = dict(fields, id=uuid(self.entropy), type=kind, occurred_at=stamp(unix_seconds))
        validate_command(command)
        record = dict(self.record)
        record["commands"] = self.record["commands"] + [command]
        record["notice"] = ""
        self._save(record)
        return command

    def capture(self):
        return dict(self.record["commands"][0]) if self.count else None

    def accepted(self, response):
        if (not self.count or response.get("command_id") != self.record["commands"][0]["id"]
                or response.get("state") not in ("accepted", "rejected")
                or not revision(response.get("revision")) or not isinstance(response.get("timer"), dict)):
            raise ValueError("Account receipt does not match pending command")
        record = dict(self.record)
        command = self.record["commands"][0]
        record["commands"] = self.record["commands"][1:]
        if response["state"] == "accepted":
            record["awaiting"] = self.record["awaiting"] + [command]
        else:
            record["notice"] = ("Timer changed elsewhere. Synced state will refresh."
                                if command["type"] in TIMER_COMMANDS else "Action was not accepted. Try again after sync.")
        self._save(record)

    def checkpoint(self):
        if self.record["awaiting"]:
            record = dict(self.record)
            record["awaiting"] = []
            self._save(record)
