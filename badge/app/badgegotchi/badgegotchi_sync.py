"""Durable wellness uploads and a real PowerSync-core download supervisor.

All networking runs after SQL commits. Connected is distinct from a checkpoint
that includes every accepted upload. Local timer history is never fabricated.
"""
import binascii
import hashlib
import json
import time
from badgegotchi_pairing import PENDING
from badgegotchi_private import PrivateFile
from badgegotchi_http import Gateway, HTTPS, split_https

MAX_EVENTS = 16
MAX_LINE = 8192


def uuid(entropy):
    value = bytearray(entropy(16))
    if len(value) != 16:
        raise ValueError("UUID randomness unavailable")
    value[6] = (value[6] & 15) | 64
    value[8] = (value[8] & 63) | 128
    text = binascii.hexlify(value).decode()
    return text[:8] + "-" + text[8:12] + "-" + text[12:16] + "-" + text[16:20] + "-" + text[20:]


def digest(events):
    return binascii.hexlify(hashlib.sha256(json.dumps(events).encode()).digest()).decode()


def validate_queue(value):
    if not isinstance(value, dict) or set(value) != {"owner_id", "device_id", "events", "inflight"}:
        raise ValueError("Unsupported saved upload queue")
    events = value["events"]
    if not isinstance(events, list) or len(events) > MAX_EVENTS:
        raise ValueError("Invalid saved upload queue size")
    ids = set()
    for event in events:
        if (not isinstance(event, dict) or set(event) != {"id", "type", "occurred_at", "day_key"}
                or event["type"] not in ("hydration", "movement")
                or not isinstance(event["id"], str) or len(event["id"]) != 36
                or not isinstance(event["occurred_at"], str) or len(event["occurred_at"]) != 20
                or not isinstance(event["day_key"], str) or len(event["day_key"]) != 10
                or event["day_key"] != event["occurred_at"][:10] or event["id"] in ids):
            raise ValueError("Invalid saved upload event")
        ids.add(event["id"])
    captured = value["inflight"]
    if captured is not None:
        if (not isinstance(captured, dict) or set(captured) != {"request_id", "count", "digest"}
                or type(captured["count"]) is not int or not 1 <= captured["count"] <= min(8, len(events))
                or not isinstance(captured["request_id"], str) or len(captured["request_id"]) != 36
                or digest(events[:captured["count"]]) != captured["digest"]):
            raise ValueError("Captured upload changed; retained")
    return value


class UploadQueue:
    def __init__(self, identity, entropy, persistence=None):
        self.entropy = entropy
        default = {"owner_id": identity["owner_id"], "device_id": identity["device_id"],
                   "events": [], "inflight": None}
        self.persistence = persistence or PrivateFile("events.json", default, validate_queue)
        self.record = self.persistence.load()
        validate_queue(self.record)
        if (self.record["owner_id"] != identity["owner_id"]
                or self.record["device_id"] != identity["device_id"]):
            raise ValueError("Another account's queued work is retained")

    @property
    def count(self):
        return len(self.record["events"])

    def _save(self, value):
        self.persistence.save(value)
        self.record = value

    def append(self, kind, unix_seconds):
        if self.count >= MAX_EVENTS:
            raise ValueError("Upload queue full. Connect before adding more.")
        if kind not in ("hydration", "movement") or type(unix_seconds) is not int:
            raise ValueError("Set the badge clock before saving account activity.")
        epoch = 946684800 if time.gmtime(0)[0] == 2000 else 0
        parts = time.gmtime(unix_seconds - epoch)
        if not 2024 <= parts[0] < 2100:
            raise ValueError("Set the badge clock before saving account activity.")
        occurred = "%04d-%02d-%02dT%02d:%02d:%02dZ" % parts[:6]
        event = {"id": uuid(self.entropy), "type": kind,
                 "occurred_at": occurred, "day_key": occurred[:10]}
        record = dict(self.record)
        record["events"] = self.record["events"] + [event]
        self._save(record)

    def capture(self):
        if not self.count:
            return None
        if self.record["inflight"] is None:
            count = min(8, self.count)
            record = dict(self.record)
            record["inflight"] = {"request_id": uuid(self.entropy), "count": count,
                                  "digest": digest(self.record["events"][:count])}
            self._save(record)
        captured = self.record["inflight"]
        return {"request_id": captured["request_id"], "events": self.record["events"][:captured["count"]]}

    def accepted(self, response):
        captured = self.record["inflight"]
        if (captured is None or response.get("state") != "accepted"
                or response.get("request_id") != captured["request_id"]
                or response.get("accepted") != captured["count"]):
            raise ValueError("Upload receipt does not match captured work")
        record = dict(self.record)
        record["events"] = record["events"][captured["count"]:]
        record["inflight"] = None
        self._save(record)


class Sync:
    def __init__(self, store, identity, queue, gateway, endpoint, ca_files,
                 heartbeat=None, http_factory=HTTPS, json_factory=Gateway, streams=("badge_projection",)):
        self.store, self.identity, self.queue, self.gateway = store, identity, queue, gateway
        self.endpoint = endpoint.rstrip("/")
        split_https(self.endpoint)
        self.ca_files, self.heartbeat = ca_files, heartbeat
        self.http_factory, self.json_factory, self.streams = http_factory, json_factory, streams
        self.store.bind_account(identity["owner_id"], identity["device_id"])
        self.phase = "token"
        self.operation = None
        self.stream = self.remote = None
        self.token = None
        self.request = None
        self.checkpoint = None
        self.target = None
        self.buffer = b""
        self.connected = False
        self.synced = False
        self.status = "CONNECTING"
        self.retry_ms = 0
        self.backoff_ms = 2000
        self.closed = False
        self.core_started = False
        self.generation = 0

    def _control(self, command, payload=None):
        return self.store.control(command, payload)

    def _disconnect(self):
        if self.stream is not None:
            self.stream.close()
        if self.remote is not None:
            self.remote.close()
        self.stream = self.remote = None
        self.gateway.close()
        if self.core_started:
            self._control("stop")
            self.core_started = False
        self.operation = None
        self.buffer = b""
        self.connected = self.synced = False

    def close(self):
        self._disconnect()
        self.closed = True
        self.token = None

    def _retry(self):
        self._disconnect()
        self.phase = "token"
        self.retry_ms = self.backoff_ms
        self.backoff_ms = min(60000, self.backoff_ms * 2)
        self.status = "OFFLINE"

    def _instructions(self, instructions):
        if not isinstance(instructions, list):
            raise ValueError("Invalid core response")
        for instruction in instructions:
            if "EstablishSyncStream" in instruction:
                establish = instruction["EstablishSyncStream"]
                self.request = establish["request"]
                self.checkpoint = establish["checkpoint_request"]
                self.phase = "seed"
            elif "FetchCredentials" in instruction:
                self.phase = "token"
            elif "CloseSyncStream" in instruction:
                if self.stream is not None:
                    self.stream.close()
                    self.stream = None
                self.connected = self.synced = False
                self.phase = "token"
            elif "DidCompleteSync" in instruction:
                self.generation += 1
                applied = instruction["DidCompleteSync"].get("applied_checkpoint_request_id")
                if (self.target is not None and applied is not None
                        and int(applied) >= int(self.target) and self.queue.count == 0):
                    self.synced = True
                    self.status = "SYNCED"
                    self.backoff_ms = 2000
            elif "CheckpointDelayedDueToLocalData" in instruction:
                raise ValueError("Unexpected local SQL writes; retained")

    def _json_request(self, action, body):
        if self.operation is None:
            self.gateway.start(dict(body, action=action))
            self.operation = action
        result = self.gateway.step()
        if result is not PENDING:
            self.operation = None
        return result

    def _checkpoint_request(self, request):
        if self.remote is None:
            self.remote = self.json_factory(self.endpoint + "/sync/checkpoint-request", self.ca_files,
                                            heartbeat=self.heartbeat, token=self.token)
            self.remote.start(request)
        result = self.remote.step()
        if result is PENDING:
            return PENDING
        self.remote.close()
        self.remote = None
        if "error" in result:
            if result["error"] == "rate_limited":
                self.backoff_ms = 60000
            raise OSError("PowerSync checkpoint unavailable")
        value = result.get("data", {}).get("checkpoint_request_id")
        if (not isinstance(value, str) or not value.isdigit() or len(value) > 19
                or not 0 < int(value) < 9223372036854775807):
            raise ValueError("Invalid PowerSync checkpoint acknowledgment")
        return value

    def step(self, elapsed_ms=0):
        if self.closed or self.phase == "revoked":
            return
        self.retry_ms = max(0, self.retry_ms - max(0, elapsed_ms))
        if self.retry_ms:
            return
        try:
            self._step()
        except OSError:
            self._retry()
        except ValueError:
            # Retain work and stop retry storms on malformed protocol/storage.
            self._disconnect()
            self.phase = "blocked"
            self.status = "SYNC ERROR"

    def _step(self):
        if self.phase == "blocked":
            return
        if self.phase == "token":
            if self.core_started:
                self._disconnect()
            self.status = "CONNECTING"
            result = self._json_request("token", {"credential": self.identity["credential"]})
            if result is PENDING:
                return
            if "error" in result:
                if result["error"] in ("unauthorized", "revoked", "invalid_credential"):
                    self._disconnect()
                    self.phase, self.status = "revoked", "REVOKED"
                    return
                if result["error"] == "rate_limited":
                    self.backoff_ms = 60000
                raise OSError("Device auth temporarily unavailable")
            if (result.get("owner_id") != self.identity["owner_id"]
                    or result.get("device_id") != self.identity["device_id"]
                    or result.get("endpoint", "").rstrip("/") != self.endpoint):
                raise ValueError("Device token identity changed")
            self.token = result["token"]
            self.phase = "upload" if self.queue.count else "start"
            return
        if self.phase == "upload":
            self.status = "UPLOADING"
            captured = self.queue.capture()
            result = self._json_request("upload", dict(captured, credential=self.identity["credential"]))
            if result is PENDING:
                return
            if "error" in result:
                if result["error"] in ("unauthorized", "revoked", "invalid_credential"):
                    self._disconnect()
                    self.phase, self.status = "revoked", "REVOKED"
                elif result["error"] in ("rate_limited", "temporarily_unavailable", "internal_error", "backend_unavailable"):
                    if result["error"] == "rate_limited":
                        self.backoff_ms = 60000
                    raise OSError("Upload unavailable")
                else:
                    self.phase, self.status = "blocked", "UPLOAD ERROR"
                return
            self.queue.accepted(result)
            self.phase = "upload" if self.queue.count else "start"
            return
        if self.phase == "start":
            for name in self.streams:
                self._control("subscriptions", json.dumps({"subscribe": {"stream": {"name": name}, "ttl": 300}}))
            self.core_started = True
            self._instructions(self._control("start", json.dumps({"checkpoint_mode": "requests", "include_defaults": False,
                               "active_streams": [{"name": name} for name in self.streams]})))
            return
        if self.phase == "seed":
            accepted = self._checkpoint_request(self.checkpoint)
            if accepted is PENDING:
                return
            self._control("seed_checkpoint_request_id", accepted)
            following = self._control("next_checkpoint_request_id")
            if isinstance(following, int):
                following = str(following)
            self.checkpoint = {"client_id": self.checkpoint["client_id"], "checkpoint_request_id": following}
            self.phase = "barrier"
            return
        if self.phase == "barrier":
            accepted = self._checkpoint_request(self.checkpoint)
            if accepted is PENDING:
                return
            self.target = accepted
            self._control("target_checkpoint_request_id", accepted)
            self.stream = self.http_factory(self.endpoint + "/sync/stream", self.request, self.ca_files,
                                             token=self.token, streaming=True, heartbeat=self.heartbeat)
            self.phase, self.status = "stream", "SYNCING"
            return
        if self.phase == "stream":
            if self.queue.count:
                self._disconnect()
                self.phase = "token"
                return
            if b"\n" in self.buffer:
                self._line()
                return
            data = self.stream.step()
            if self.stream.status is not None and not self.connected:
                if self.stream.status == 401:
                    self._retry()
                    return
                if self.stream.status != 200:
                    raise OSError("PowerSync stream unavailable")
                self.connected = True
                self._instructions(self._control("connection", "established"))
            if data is PENDING:
                return
            if data is None:
                if self.buffer:
                    raise ValueError("Truncated PowerSync line")
                self._retry()
                return
            self.buffer += data
            # One native line per foreground frame. Leave the remaining bytes
            # queued and pause socket reads while the core applies this line.
            self._line()

    def _line(self):
        position = self.buffer.find(b"\n")
        if position < 0:
            if len(self.buffer) > MAX_LINE:
                raise ValueError("PowerSync line exceeds limit")
            return
        if position > MAX_LINE:
            raise ValueError("PowerSync line exceeds limit")
        line, self.buffer = self.buffer[:position].rstrip(b"\r"), self.buffer[position + 1:]
        if line:
            self._instructions(self._control("line_text", line.decode()))
