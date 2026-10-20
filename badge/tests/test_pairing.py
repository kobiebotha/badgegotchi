"""Host protocol tests: no badge access, native loading, or live requests."""
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app" / "badgegotchi"))
from badgegotchi_pairing import Pairing, PENDING
from badgegotchi_private import pairing_file
from badgegotchi_http import Response, Gateway, split_https
from badgegotchi_sync import Sync, UploadQueue, validate_queue


class Memory:
    def __init__(self, value):
        self.value = copy.deepcopy(value)
        self.writes = []
        self.fail = False

    def load(self):
        return copy.deepcopy(self.value)

    def save(self, value):
        if self.fail:
            raise OSError("disk full")
        self.writes.append(copy.deepcopy(value))
        self.value = copy.deepcopy(value)


class Entropy:
    def __init__(self):
        self.count = 0

    def __call__(self, size):
        self.count += 1
        return bytes([self.count]) * size


class GatewayFake:
    def __init__(self, responses=()):
        self.responses = list(responses)
        self.calls = []
        self.closed = False

    def start(self, body):
        self.calls.append(copy.deepcopy(body))

    def step(self):
        value = self.responses.pop(0) if self.responses else PENDING
        if isinstance(value, Exception):
            raise value
        return value

    def close(self):
        self.closed = True


IDENTITY = {"state": "paired", "credential": "a" * 64, "device_id": "device", "owner_id": "owner"}


class PairingTests(unittest.TestCase):
    def setup_pairing(self, responses=()):
        self.persistence = Memory({"state": "unpaired"})
        self.gateway = GatewayFake(responses)
        self.entropy = Entropy()
        return Pairing(self.persistence, self.gateway, self.entropy)

    def enter(self, pairing, code="ABCABCABCABC"):
        for symbol in code:
            pairing.step((), 0)
            pairing.step((symbol,), 0)

    def test_launch_hold_chords_and_repeat_require_full_release(self):
        pairing = self.setup_pairing()
        pairing.step(("A",), 0)
        pairing.step(("A",), 100)
        self.assertEqual(pairing.code, "")
        pairing.step((), 0)
        pairing.step(("A", "B"), 0)
        pairing.step(("A",), 0)
        self.assertEqual(pairing.code, "")
        pairing.step((), 0)
        pairing.step(("C",), 0)
        pairing.step(("C",), 1000)
        self.assertEqual(pairing.code, "C")
        pairing.step((), 0)
        pairing.step(("UP",), 0)
        self.assertEqual(pairing.code, "")

    def test_no_request_or_app_before_twelve_symbols(self):
        pairing = self.setup_pairing()
        self.enter(pairing, "ABCABCABCAB")
        self.assertFalse(pairing.paired)
        self.assertEqual(self.gateway.calls, [])
        self.assertEqual(self.persistence.writes, [])

    def test_claim_persisted_before_request_and_lost_reply_reuses_exact_secrets(self):
        pairing = self.setup_pairing([OSError("lost response")])
        self.enter(pairing)
        first = self.gateway.calls[0]
        self.assertEqual(first["credential"], self.persistence.value["credential"])
        self.assertNotEqual(first["credential"], first["pending_secret"])
        restored = Pairing(self.persistence, self.gateway, self.entropy)
        restored.step((), 0)
        self.assertEqual(self.gateway.calls[-1], first)
        self.assertEqual(self.entropy.count, 2)

    def test_storage_failure_never_sends_enrollment(self):
        pairing = self.setup_pairing()
        self.persistence.fail = True
        with self.assertRaises(OSError):
            self.enter(pairing)
        self.assertEqual(self.gateway.calls, [])

    def test_exact_web_approval_ack_and_pair_once_reentry(self):
        claim = {"claim_id": "claim", "verification_id": "ABCD-EFGH", "state": "pending"}
        approved = dict(claim, state="approved", owner_id="owner", device_id="device")
        pairing = self.setup_pairing([claim, approved, {"state": "active", "owner_id": "owner", "device_id": "device"}])
        self.enter(pairing)
        self.assertFalse(pairing.paired)
        self.assertEqual(pairing.verification_id, "ABCD-EFGH")
        pairing.step((), 2500)
        self.assertFalse(pairing.paired)
        pairing.step((), 0)
        self.assertTrue(pairing.paired)
        self.assertNotIn("pending_secret", self.persistence.value)
        self.assertNotIn("code", self.persistence.value)
        restored = Pairing(self.persistence, self.gateway, self.entropy)
        self.assertTrue(restored.paired)

    def test_claim_identifier_mismatch_cannot_authorize(self):
        pairing = self.setup_pairing([{"claim_id": "one", "verification_id": "ID", "state": "pending"},
                                      {"claim_id": "other", "verification_id": "ID", "state": "approved"}])
        self.enter(pairing)
        with self.assertRaisesRegex(ValueError, "identity changed"):
            pairing.step((), 2500)
        self.assertFalse(pairing.paired)

    def test_expiry_requires_fresh_code_and_home_preserves_pending(self):
        pairing = self.setup_pairing([{"error": "pairing_unavailable"}])
        self.enter(pairing)
        self.assertEqual(pairing.state, "failed")
        saved = copy.deepcopy(self.persistence.value)
        pairing.close()
        self.assertEqual(saved, self.persistence.value)
        self.assertTrue(self.gateway.closed)

    def test_entropy_failure_fails_closed(self):
        pairing = self.setup_pairing()
        pairing.entropy = lambda size: b"x" * size
        with self.assertRaises(ValueError):
            self.enter(pairing)
        self.assertEqual(self.gateway.calls, [])


class PrivateFileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "private"
        self.file = pairing_file(str(self.root))

    def test_atomic_write_failed_rename_retains_previous_pairing(self):
        with patch("badgegotchi_private.os.sync", create=True):
            self.assertEqual(self.file.load(), {"state": "unpaired"})
            self.file.save(IDENTITY)
            previous = (self.root / "pairing.json").read_bytes()
            with patch("badgegotchi_private.os.rename", side_effect=OSError("interrupted")):
                with self.assertRaises(OSError):
                    self.file.save(dict(IDENTITY, device_id="new"))
            self.assertEqual((self.root / "pairing.json").read_bytes(), previous)
            self.assertEqual(self.file.load(), IDENTITY)

    def test_unowned_or_unknown_data_never_adopted(self):
        self.root.mkdir()
        path = self.root / "other.json"
        path.write_text("keep me")
        with self.assertRaises(ValueError):
            self.file.load()
        self.assertEqual(path.read_text(), "keep me")


class HttpTests(unittest.TestCase):
    def consume(self, encoded, split):
        response = Response()
        result = response.feed(encoded[:split]) + response.feed(encoded[split:])
        response.finish()
        return result

    def test_every_fragment_split_for_lengths_and_chunked(self):
        cases = (
            b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nabcxyz",
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n3\r\nxyz\r\n0\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nabcxyz",
        )
        for encoded in cases:
            for split in range(len(encoded) + 1):
                with self.subTest(split=split, encoded=encoded):
                    self.assertEqual(self.consume(encoded, split), b"abcxyz")
            response = Response()
            self.assertEqual(b"".join(response.feed(bytes([value])) for value in encoded), b"abcxyz")
            response.finish()

    def test_ambiguous_oversized_compressed_truncated_http_rejected(self):
        bad = (
            b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\nx",
            b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\nx",
            b"HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\n\r\nx",
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nx",
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nx",
            b"HTTP/1.1 200 OK\r\n" + b"X" * 5000,
        )
        for encoded in bad:
            with self.subTest(encoded=encoded[:100]), self.assertRaises((ValueError, OSError)):
                self.consume(encoded, 4)

    def test_targets_reject_cleartext_credentials_ports_and_header_injection(self):
        for url in ("http://foo", "https://name:pass@foo/a", "https://foo:443/a", "https://foo/a\r\nBad: x"):
            with self.assertRaises(ValueError):
                split_https(url)


class QueueTests(unittest.TestCase):
    def setup_queue(self):
        self.memory = Memory({"owner_id": "owner", "device_id": "device", "events": [], "inflight": None})
        self.entropy = Entropy()
        return UploadQueue(IDENTITY, self.entropy, self.memory)

    def test_capture_is_durable_exact_across_restart_and_acceptance_removes_only_it(self):
        queue = self.setup_queue()
        queue.append("hydration", 1792526000)
        first = queue.capture()
        queue.append("movement", 1792526001)
        restored = UploadQueue(IDENTITY, self.entropy, self.memory)
        self.assertEqual(restored.capture(), first)
        restored.accepted({"state": "accepted", "request_id": first["request_id"], "accepted": 1})
        self.assertEqual(restored.count, 1)
        self.assertEqual(restored.record["events"][0]["type"], "movement")

    def test_mismatched_receipt_and_edited_capture_are_retained(self):
        queue = self.setup_queue()
        queue.append("hydration", 1792526000)
        queue.capture()
        before = copy.deepcopy(self.memory.value)
        with self.assertRaises(ValueError):
            queue.accepted({"state": "accepted", "request_id": "other", "accepted": 1})
        self.assertEqual(self.memory.value, before)
        changed = copy.deepcopy(before)
        changed["events"][0]["type"] = "movement"
        with self.assertRaisesRegex(ValueError, "Captured upload"):
            validate_queue(changed)

    def test_bound_capacity_account_switch_and_unset_clock_are_refused(self):
        queue = self.setup_queue()
        for index in range(16):
            queue.append("hydration", 1792526000 + index)
        with self.assertRaisesRegex(ValueError, "queue full"):
            queue.append("hydration", 1792526000)
        with self.assertRaisesRegex(ValueError, "Another account"):
            UploadQueue(dict(IDENTITY, owner_id="other"), self.entropy, self.memory)
        queue = self.setup_queue()
        with self.assertRaisesRegex(ValueError, "clock"):
            queue.append("hydration", None)

    def test_capture_failure_never_advances_memory_authority(self):
        queue = self.setup_queue()
        queue.append("hydration", 1792526000)
        self.memory.fail = True
        with self.assertRaises(OSError):
            queue.capture()
        self.assertIsNone(queue.record["inflight"])


class StoreFake:
    def __init__(self):
        self.commands = []

    def bind_account(self, *identity):
        self.identity = identity

    def control(self, command, payload=None):
        self.commands.append((command, payload))
        if command == "start":
            return [{"EstablishSyncStream": {"request": {"buckets": []},
                       "checkpoint_request": {"client_id": "client", "checkpoint_request_id": "1"}}}]
        if command == "next_checkpoint_request_id":
            return 9007199254740994
        if command == "line_text":
            if json.loads(payload).get("checkpoint_complete"):
                return [{"DidCompleteSync": {"applied_checkpoint_request_id": "9007199254740994"}}]
        return []


class StreamFake:
    def __init__(self, *args, **kwargs):
        self.status = 200
        self.parts = [b'{"checkpoint_complete":true}\n', PENDING]
        self.closed = False

    def step(self):
        return self.parts.pop(0) if self.parts else PENDING

    def close(self):
        self.closed = True


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.store = StoreFake()
        memory = Memory({"owner_id": "owner", "device_id": "device", "events": [], "inflight": None})
        self.queue = UploadQueue(IDENTITY, Entropy(), memory)
        token = dict(IDENTITY, token="jwt", endpoint="https://sync.example", expires_at=1792526300)
        self.gateway = GatewayFake([token])
        self.checkpoints = []
        def json_factory(*args, **kwargs):
            remote = GatewayFake([{"data": {"checkpoint_request_id": "9007199254740993" if not self.checkpoints else "9007199254740994"}}])
            self.checkpoints.append(remote)
            return remote
        self.sync = Sync(self.store, IDENTITY, self.queue, self.gateway, "https://sync.example", ("ca",),
                         http_factory=StreamFake, json_factory=json_factory)

    def ready(self):
        for _ in range(4):
            self.sync.step()

    def test_checkpoint_exchange_precedes_synced_and_preserves_64bit_ids(self):
        self.ready()
        self.assertEqual(self.sync.phase, "stream")
        self.assertFalse(self.sync.synced)
        self.assertIn(("seed_checkpoint_request_id", "9007199254740993"), self.store.commands)
        self.assertIn(("target_checkpoint_request_id", "9007199254740994"), self.store.commands)
        self.assertEqual(self.checkpoints[1].calls[0]["checkpoint_request_id"], "9007199254740994")
        self.sync.step()
        self.assertTrue(self.sync.connected)
        self.assertTrue(self.sync.synced)

    def test_old_checkpoint_cannot_report_synced_and_pending_work_closes_stream(self):
        self.ready()
        self.sync._instructions([{"DidCompleteSync": {"applied_checkpoint_request_id": "2"}}])
        self.assertFalse(self.sync.synced)
        stream = self.sync.stream
        self.queue.append("hydration", 1792526000)
        self.sync.step()
        self.assertTrue(stream.closed)
        self.assertFalse(self.sync.synced)
        self.assertEqual(self.queue.count, 1)

    def test_token_subject_or_endpoint_change_blocks_without_cross_account_sync(self):
        self.gateway.responses = [dict(IDENTITY, owner_id="other", token="jwt", endpoint="https://sync.example")]
        self.sync.step()
        self.assertEqual(self.sync.phase, "blocked")
        self.assertEqual(self.checkpoints, [])

    def test_revoked_credential_retains_private_events_and_stops(self):
        self.queue.append("hydration", 1792526000)
        self.gateway.responses = [{"error": "unauthorized"}]
        self.sync.step()
        self.assertEqual(self.sync.phase, "revoked")
        self.assertEqual(self.queue.count, 1)

    def test_wifi_retry_and_home_cancel_preserve_pending_queue(self):
        self.queue.append("hydration", 1792526000)
        self.gateway.responses = [OSError("wifi down")]
        self.sync.step()
        self.assertEqual(self.sync.status, "OFFLINE")
        self.assertGreater(self.sync.retry_ms, 0)
        self.sync.close()
        self.assertEqual(self.queue.count, 1)
        self.assertTrue(self.gateway.closed)

    def test_lost_upload_reply_reuses_captured_request_then_waits_for_checkpoint(self):
        self.queue.append("hydration", 1792526000)
        token = copy.deepcopy(self.gateway.responses[0])
        self.sync.step()
        self.gateway.responses = [OSError("reply lost")]
        self.sync.step()
        captured = copy.deepcopy(self.gateway.calls[-1])
        self.assertEqual(self.queue.count, 1)
        self.gateway.responses = [token, {"state": "accepted", "request_id": captured["request_id"], "accepted": 1}]
        self.sync.step(2000)
        self.sync.step()
        self.assertEqual(self.gateway.calls[-1], captured)
        self.assertEqual(self.queue.count, 0)
        self.assertFalse(self.sync.synced)
        self.assertEqual(self.sync.phase, "start")

    def test_server_upload_unavailable_retries_without_removing_captured_work(self):
        self.queue.append("hydration", 1792526000)
        self.sync.step()
        self.gateway.responses = [{"error": "backend_unavailable"}]
        self.sync.step()
        self.assertEqual(self.sync.status, "OFFLINE")
        self.assertEqual(self.queue.count, 1)
        self.assertIsNotNone(self.queue.record["inflight"])

    def test_coalesced_lines_are_drained_without_additional_socket_read(self):
        self.ready()
        self.sync.lines.feed(b'{"a":1}\n{"b":2}\n')
        before = list(self.sync.stream.parts)
        self.sync.step()
        self.assertEqual(self.sync.lines.pending[self.sync.lines.offset:], b'{"b":2}\n')
        self.assertEqual(self.sync.stream.parts, before)


class RealCoreSupervisorTests(unittest.TestCase):
    def test_requests_mode_supervisor_publishes_one_projection_with_real_core(self):
        # Synthetic HTTPS responses exercise the real SQL core and supervisor;
        # this is bounded host integration, not live-service or badge evidence.
        from test_storage import HostCore, HOST_LIBRARY, storage
        if not HOST_LIBRARY.exists():
            self.skipTest("Build pinned real-core host qualifier first")
        with tempfile.TemporaryDirectory() as directory:
            store = storage.Store(native=HostCore(), root=directory + "/badge")
            store.open()
            sync = None
            try:
                identity = dict(IDENTITY, owner_id="11111111-1111-4111-8111-111111111111",
                                 device_id="22222222-2222-4222-8222-222222222222")
                memory = Memory({"owner_id": identity["owner_id"], "device_id": identity["device_id"],
                                 "events": [], "inflight": None})
                queue = UploadQueue(identity, Entropy(), memory)
                token = dict(identity, token="fixture", endpoint="https://sync.example", expires_at=1792526300)
                calls = []
                def checkpoint_factory(*args, **kwargs):
                    remote = GatewayFake([{"data": {"checkpoint_request_id":
                        "9007199254740993" if not calls else "9007199254740994"}}])
                    calls.append(remote)
                    return remote
                class FixtureStream(StreamFake):
                    def __init__(self, *args, **kwargs):
                        super().__init__(*args, **kwargs)
                        self.request_body = copy.deepcopy(args[1])
                        payload = {"kind": "summary", "payload": json.dumps({"hydration_count": 5})}
                        lines = [
                            {"checkpoint": {"last_op_id": "1", "write_checkpoint": "9007199254740994",
                             "buckets": [{"bucket": "fixture", "checksum": 1, "priority": 3, "count": 1}]}},
                            {"data": {"bucket": "fixture", "has_more": False, "after": None, "next_after": "1",
                             "data": [{"op_id": "1", "op": "PUT", "object_type": "badge_projection",
                             "object_id": "summary", "checksum": 1, "data": json.dumps(payload)}]}},
                            {"checkpoint_complete": {"last_op_id": "1"}},
                        ]
                        self.parts = [(json.dumps(line) + "\n").encode() for line in lines] + [PENDING]
                sync = Sync(store, identity, queue, GatewayFake([token]), "https://sync.example", ("ca",),
                            http_factory=FixtureStream, json_factory=checkpoint_factory)
                for _ in range(4):
                    sync.step()
                self.assertEqual(sync.phase, "stream")
                # The service rejects top-level parameters:null, but requires
                # nullable fields on each subscription. Inspect the actual core
                # request passed to HTTP instead of the fake core's start input.
                request = sync.stream.request_body
                self.assertIsInstance(request["parameters"], dict)
                self.assertEqual(request["parameters"], {})
                self.assertTrue(request["raw_data"])
                self.assertEqual(request["streams"], {"include_defaults": False,
                    "subscriptions": [{"stream": "badge_projection", "parameters": None,
                                       "override_priority": None}]})
                self.assertFalse(sync.synced)
                self.assertEqual(store.projection(), [])
                sync.step()
                self.assertTrue(sync.connected)
                self.assertFalse(sync.synced)
                sync.step()
                self.assertEqual(store.projection(), [])
                sync.step()
                self.assertTrue(sync.synced)
                self.assertEqual(store.projection()[0]["payload"], {"hydration_count": 5})
                self.assertEqual(store._scalar("SELECT count(*) FROM ps_crud"), "0")
                self.assertEqual(store._scalar("PRAGMA integrity_check"), "ok")
            finally:
                if sync is not None:
                    sync.close()
                store.close()


class AccountDetailsTests(unittest.TestCase):
    def test_immutable_legacy_and_actual_account_day_are_distinct(self):
        from badgegotchi_view import AppView
        view = AppView.__new__(AppView)
        rendered = []
        view.header = lambda *args: None
        view.box = lambda *args: None
        view.text = lambda value, *args, **kwargs: rendered.append(value)
        view.ink = view.green = view.muted = view.paper = None
        client = SimpleNamespace(status="OFFLINE", legacy={"focus_count": 7, "water_count": 9,
                                  "stretch_count": 4, "pet_count": 12}, queue=SimpleNamespace(count=2),
                                  projection={"summary": {"day_key": "2026-10-19", "hydration_count": 3,
                                              "movement_count": 2, "completed_focus_count": 1}})
        before = copy.deepcopy(client.legacy)
        view.details(client)
        self.assertIn("Before pairing (kept on this badge)", rendered)
        self.assertIn("Water 9", rendered)
        self.assertIn("Account 2026-10-19", rendered)
        self.assertIn("Water 3  Move 2  Focus 1", rendered)
        self.assertFalse(any("today" in text.lower() for text in rendered))
        self.assertEqual(client.legacy, before)

    def test_details_never_invents_legacy_totals_for_a_fresh_badge(self):
        from badgegotchi_view import AppView
        view = AppView.__new__(AppView)
        rendered = []
        view.header = lambda *args: None
        view.box = lambda *args: None
        view.text = lambda value, *args, **kwargs: rendered.append(value)
        view.ink = view.green = view.muted = view.paper = None
        view.details(SimpleNamespace(status="OFFLINE", legacy=None, projection={}, queue=SimpleNamespace(count=0)))
        self.assertIn("No earlier badge totals.", rendered)
        self.assertNotIn("Water 0", rendered)

    def test_details_are_read_only_and_exiting_requires_button_release(self):
        from badgegotchi_client import Client
        legacy = {"focus_count": 7, "water_count": 9, "stretch_count": 4, "pet_count": 12}
        store = SimpleNamespace(legacy=lambda: dict(legacy), projection=lambda: [])
        runtime = SimpleNamespace(status="OFFLINE", phase="token", generation=0, step=lambda elapsed: None)
        with patch("badgegotchi_client.Pairing", return_value=SimpleNamespace(paired=True, record=IDENTITY)), \
             patch("badgegotchi_client.pairing_file"), patch("badgegotchi_client.Gateway"), \
             patch("badgegotchi_client.UploadQueue"), patch("badgegotchi_client.Sync", return_value=runtime):
            client = Client(store)
            client.step(["DOWN"], 0)
            self.assertFalse(client.show_details)
            client.step([], 0)
            client.step(["DOWN"], 0)
            self.assertTrue(client.show_details)
            self.assertFalse(client.controls_enabled)
            client.step(["DOWN"], 1000)
            self.assertTrue(client.show_details)
            client.step([], 0)
            client.step(["DOWN"], 0)
            self.assertFalse(client.show_details)
            client.step(["B"], 0)
            self.assertFalse(client.controls_enabled)
            client.step([], 0)
            self.assertTrue(client.controls_enabled)
            self.assertEqual(client.legacy, legacy)


if __name__ == "__main__":
    unittest.main()
