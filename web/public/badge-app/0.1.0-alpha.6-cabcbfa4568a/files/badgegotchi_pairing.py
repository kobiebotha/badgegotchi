"""Pair-once ABC enrollment. Network and durable writes are injected boundaries."""
import binascii

CODE_LENGTH = 12
PENDING = object()


class Pairing:
    def __init__(self, persistence, gateway, entropy):
        self.persistence = persistence
        self.gateway = gateway
        self.entropy = entropy
        self.record = persistence.load()
        self.code = ""
        self.verification_id = self.record.get("verification_id", "")
        self.state = "paired" if self.record.get("state") == "paired" else "enter"
        if self.record.get("state") == "pending":
            self.state = "waiting"
        self.error = ""
        self.retry_ms = 0
        self.operation = None
        self._release = True
        self._held = set()
        self.closed = False

    @property
    def paired(self):
        return self.state == "paired"

    def _save(self, record):
        # The in-memory authority changes only after its durable write succeeds.
        self.persistence.save(record)
        self.record = record

    def _new_pending(self):
        first = self.entropy(32)
        second = self.entropy(32)
        if (not isinstance(first, bytes) or not isinstance(second, bytes)
                or len(first) != 32 or len(second) != 32 or first == second):
            raise ValueError("Secure enrollment randomness unavailable")
        self._save({"state": "pending", "pending_secret": binascii.hexlify(first).decode(),
                    "credential": binascii.hexlify(second).decode(), "code": self.code})

    def _request(self, action, body):
        self.operation = action
        self.gateway.start(dict(body, action=action))

    def _press(self, held):
        held = set(held)
        if self._release:
            self._release = bool(held)
            self._held = held
            return None
        pressed = held - self._held
        self._held = held
        # Chords are rejected as ambiguous; every symbol requires a full release.
        if not pressed or len(held) != 1:
            if held:
                self._release = True
            return None
        self._release = True
        return next(iter(pressed))

    def step(self, held=(), elapsed_ms=0):
        if self.closed or self.paired:
            return
        button = self._press(held)
        self.retry_ms = max(0, self.retry_ms - max(0, elapsed_ms))
        if self.state == "enter":
            if button == "UP":
                self.code = self.code[:-1]
            elif button in ("A", "B", "C") and len(self.code) < CODE_LENGTH:
                self.code += button
            if len(self.code) == CODE_LENGTH:
                self._new_pending()
                self.state = "waiting"
                self.error = ""
        if self.state == "failed":
            if button == "B":
                # A terminal server rejection permits fresh enrollment. A network
                # error never clears the stable credential or pending secret.
                self._save({"state": "unpaired"})
                self.code = ""
                self.verification_id = ""
                self.state = "enter"
            return
        if self.state != "waiting":
            return
        if self.operation is None:
            if self.retry_ms:
                return
            if self.record.get("approved"):
                self._request("ack", {"credential": self.record["credential"]})
            elif self.record.get("claim_id"):
                self._request("poll", {"pending_secret": self.record["pending_secret"]})
            else:
                self._request("claim", {key: self.record[key] for key in
                                        ("code", "pending_secret", "credential")})
        try:
            reply = self.gateway.step()
        except (OSError, ValueError):
            self.gateway.close()
            self.operation = None
            self.retry_ms = 5000
            self.error = "Network unavailable. Retrying..."
            return
        if reply is PENDING:
            return
        action = self.operation
        self.operation = None
        self.retry_ms = 2500
        if "error" in reply:
            error = reply["error"]
            if error in ("expired", "cancelled", "rejected", "invalid_code", "invalid_claim",
                         "pairing_unavailable", "claim_expired", "not_found", "revoked"):
                self.state = "failed"
                self.error = "Pairing ended. B: enter a new code."
            else:
                self.error = "Pairing unavailable. Retrying..."
                self.retry_ms = 60000 if error == "rate_limited" else 15000
            return
        self.error = ""
        if action == "claim":
            claim = reply.get("claim_id")
            verification = reply.get("verification_id")
            if not isinstance(claim, str) or not isinstance(verification, str) or not 1 <= len(verification) <= 40:
                raise ValueError("Invalid enrollment response")
            record = dict(self.record)
            record.update(claim_id=claim, verification_id=verification)
            self._save(record)
            self.verification_id = verification
        elif action == "poll":
            if (reply.get("claim_id") != self.record["claim_id"]
                    or reply.get("verification_id") != self.verification_id):
                raise ValueError("Enrollment identity changed")
            state = reply.get("state")
            if state in ("approved", "delivered", "active"):
                record = dict(self.record)
                record.update(approved=True, device_id=reply["device_id"], owner_id=reply["owner_id"])
                self._save(record)
                self.retry_ms = 0
            elif state in ("expired", "cancelled", "rejected", "revoked"):
                self.state = "failed"
                self.error = "Pairing ended. B: enter a new code."
            elif state != "pending":
                raise ValueError("Invalid pairing state")
        elif action == "ack":
            if (reply.get("state") != "active" or reply.get("device_id") != self.record.get("device_id")
                    or reply.get("owner_id") != self.record.get("owner_id")):
                raise ValueError("Device identity changed")
            self._save({"state": "paired", "credential": self.record["credential"],
                        "device_id": reply["device_id"], "owner_id": reply["owner_id"]})
            self.code = ""
            self.state = "paired"

    def close(self):
        self.closed = True
        self.gateway.close()
        self.operation = None
