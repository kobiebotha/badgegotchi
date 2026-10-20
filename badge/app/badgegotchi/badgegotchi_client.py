"""Launch gate and the account link; the local timer remains independently saved."""
from badgegotchi_pairing import Pairing
from badgegotchi_private import pairing_file
from badgegotchi_http import Gateway
from badgegotchi_sync import UploadQueue, Sync


class Client:
    def __init__(self, store, heartbeat=None):
        from badgegotchi_config import GATEWAY_URL, POWERSYNC_URL, CA_FILES, STREAMS
        from badgegotchi_entropy import secret_bytes
        self.store, self.heartbeat = store, heartbeat
        self.endpoint, self.ca_files, self.streams = POWERSYNC_URL, CA_FILES, STREAMS
        self.entropy = secret_bytes
        self.gateway = Gateway(GATEWAY_URL, CA_FILES, heartbeat)
        self.pairing = Pairing(pairing_file(), self.gateway, secret_bytes)
        self.sync = self.queue = None
        self.ready = False
        self.controls_enabled = False
        self.show_details = False
        self._down_held = False
        self.legacy = store.legacy()
        self.projection = {}
        self._generation = -1

    @property
    def status(self):
        return self.sync.status if self.sync is not None else "PAIR BADGE"

    def step(self, held, elapsed_ms):
        if not self.pairing.paired:
            self.pairing.step(held, elapsed_ms)
            return
        if self.sync is None:
            self.queue = UploadQueue(self.pairing.record, self.entropy)
            self.sync = Sync(self.store, self.pairing.record, self.queue, self.gateway,
                             self.endpoint, self.ca_files, self.heartbeat, streams=self.streams)
        down = "DOWN" in held
        if self.ready and down and not self._down_held and len(held) == 1:
            self.show_details = not self.show_details
            self.controls_enabled = False
        self._down_held = down
        if not held:
            self.ready = True
            self.controls_enabled = not self.show_details
        self.sync.step(elapsed_ms)
        if self.sync.phase == "revoked":
            self.ready = False
            self.controls_enabled = False
        if self.sync.generation != self._generation:
            self.projection = {row["kind"]: row["payload"] for row in self.store.projection()}
            self._generation = self.sync.generation

    def record_events(self, state, previous, clock):
        for key, kind in (("water_count", "hydration"), ("stretch_count", "movement")):
            if getattr(state, key) > previous[key]:
                try:
                    self.queue.append(kind, clock())
                    state._say("Saved for your account. " + ("Syncing..." if self.sync.connected else "Waiting for Wi-Fi."))
                    self.sync.synced = False
                    self.sync.status = "PENDING"
                except ValueError as exc:
                    setattr(state, key, previous[key])
                    state._say(str(exc))

    def close(self):
        if self.sync is not None:
            self.sync.close()
        self.pairing.close()
