"""Pairing, canonical account projections and durable shared actions."""
from badgegotchi_pairing import Pairing
from badgegotchi_private import pairing_file
from badgegotchi_http import Gateway
from badgegotchi_sync import UploadQueue, Sync, uuid
from badgegotchi_commands import CommandQueue
from badgegotchi_state import AppState, rtc_seconds, transition_seconds


class Client:
    def __init__(self, store, heartbeat=None, clock=rtc_seconds):
        from badgegotchi_config import GATEWAY_URL, POWERSYNC_URL, CA_FILES, STREAMS
        from badgegotchi_entropy import secret_bytes
        self.store, self.heartbeat, self.clock = store, heartbeat, clock
        self.endpoint, self.ca_files, self.streams = POWERSYNC_URL, CA_FILES, STREAMS
        self.entropy = secret_bytes
        self.gateway = Gateway(GATEWAY_URL, CA_FILES, heartbeat)
        self.pairing = Pairing(pairing_file(), self.gateway, secret_bytes)
        self.sync = self.queue = self.legacy_queue = None
        self.ready = self.controls_enabled = self.show_details = False
        self._down_held = self._input_ready = False
        self.projection = {}
        self._generation = -1
        self.state = AppState(clock)
        self._last_notice = ""
        self._completion_retry_ms = 0
        self._completion_wait_generation = None

    @property
    def status(self):
        return self.sync.status if self.sync is not None else "PAIR BADGE"

    @property
    def pending_count(self):
        return ((self.queue.pending_count if self.queue is not None else 0) +
                (self.legacy_queue.count if self.legacy_queue is not None else 0))

    def _action(self, action):
        kind, fields = None, {}
        timer = self.state.timer
        if action in ("water", "stretch"):
            kind = "hydration" if action == "water" else "movement"
        elif action == "pet":
            if not self.state.pet.get("id"):
                raise ValueError("Wait for your account pet to sync.")
            if (self.state.pet.get("status") in ("pending", "processing")
                    or any(command["type"] == "pet" for command in self.queue.optimistic)):
                raise ValueError("Your pet is thinking. Try again soon.")
            kind, fields = "pet", {"pet_session_id": self.state.pet["id"]}
        elif action in ("toggle", "complete", "stop"):
            if timer is None:
                raise ValueError("Wait for your account timer to sync.")
            fields = {"expected_revision": timer["revision"]}
            if timer.get("state") == "idle":
                if action != "toggle":
                    return
                kind = "timer_start"
                fields.update(new_session_id=uuid(self.entropy), session_type=timer.get("type", "focus"))
            else:
                fields["session_id"] = timer["id"]
                if action == "complete":
                    kind = "timer_complete"
                elif action == "stop":
                    kind = "timer_stop"
                else:
                    kind = "timer_pause" if timer.get("state") == "active" else "timer_resume"
        if kind is None:
            return
        occurred = self.clock()
        if kind.startswith("timer_"):
            occurred = transition_seconds(timer, occurred)
        self.queue.append(kind, occurred, **fields)
        if action == "complete":
            self._completion_retry_ms = 5000
            self._completion_wait_generation = self.sync.generation
        self.sync.synced = False
        self.sync.status = "PENDING"
        if action == "pet":
            self.state.reaction_ms = 1800
        self.state._say("Saved for your account. " + ("Syncing..." if self.sync.connected else "Waiting for Wi-Fi."))
        self.state.refresh(self.projection, self.queue.optimistic)

    def step(self, held, elapsed_ms):
        if not self.pairing.paired:
            self.pairing.step(held, elapsed_ms)
            return
        if self.sync is None:
            self.legacy_queue = UploadQueue(self.pairing.record, self.entropy)
            self.queue = CommandQueue(self.pairing.record, self.entropy)
            self.sync = Sync(self.store, self.pairing.record, self.legacy_queue, self.gateway,
                             self.endpoint, self.ca_files, self.heartbeat, streams=self.streams, commands=self.queue)
        down = "DOWN" in held
        if self.ready and down and not self._down_held and len(held) == 1:
            self.show_details = not self.show_details
            self.controls_enabled = self._input_ready = False
        self._down_held = down
        if not held:
            self.ready = self._input_ready = True
            self.controls_enabled = not self.show_details
        self.sync.step(elapsed_ms)
        if self.sync.phase == "revoked":
            self.ready = self.controls_enabled = self._input_ready = False
        if self.sync.generation != self._generation:
            self.projection = {row["kind"]: row["payload"] for row in self.store.projection()}
            self._generation = self.sync.generation
        self.state.refresh(self.projection, self.queue.optimistic)
        actions = []
        if self.ready and self._input_ready:
            if self.show_details:
                actions = ["stop"] if held == ["B"] else []
            elif self.controls_enabled and len(held) <= 1:
                names = {"A": "pet", "B": "toggle", "C": "water", "UP": "stretch"}
                actions = [names[name] for name in held if name in names]
        self._completion_retry_ms = max(0, self._completion_retry_ms - max(0, elapsed_ms))
        triggered = self.state.step(actions, elapsed_ms)
        for action in triggered if self.ready and self.sync.phase not in ("blocked", "revoked") else ():
            if action == "complete" and (self._completion_retry_ms or
                    (self._completion_wait_generation is not None and
                     (not self.sync.synced or self.sync.generation <= self._completion_wait_generation))):
                continue
            try:
                self._action(action)
            except ValueError as exc:
                self.state._say(str(exc))
                if action == "complete":
                    self._completion_retry_ms = 5000
        if self.queue.notice and self.queue.notice != self._last_notice:
            self.state._say(self.queue.notice)
            self._last_notice = self.queue.notice

    def close(self):
        if self.sync is not None:
            self.sync.close()
        self.pairing.close()
