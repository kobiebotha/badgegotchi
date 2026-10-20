"""Bounded stream framing tests; the real-core case uses 28 small same-row PUTs."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app" / "badgegotchi"))
from badgegotchi_stream import StreamLines, MAX_LINE, MAX_FRAGMENT, MAX_METADATA


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


def operation(index, kind="PUT", padding=""):
    return {"op_id": str(9007199254741000 + index), "op": kind,
            "object_type": "badge_projection", "object_id": "summary", "checksum": index + 1,
            "data": json.dumps({"kind": "summary", "payload": json.dumps({"hydration_count": index, "text": padding})})}


def data_line(operations):
    return encoded({"data": {"bucket": 'badge["owner"]', "after": "0", "has_more": False,
                             "data": operations, "next_after": operations[-1]["op_id"] if operations else "0"}}) + b"\n"


def drain(wire, size=MAX_FRAGMENT):
    parser = StreamLines()
    records = []
    for offset in range(0, len(wire), size):
        parser.feed(wire[offset:offset + size])
        while True:
            line = parser.pop()
            if line is None:
                break
            records.append(line)
    parser.finish()
    return records


class StreamLinesTests(unittest.TestCase):
    def test_fragmentation_preserves_control_lines_operations_order_and_raw_json(self):
        operations = [operation(0, padding='quote " slash \\ bracket },] Unicode λ😺'),
                      operation(1, "REMOVE"), operation(2, "MOVE"), operation(3, "CLEAR")]
        control = b'  {"checkpoint": {"last_op_id":"9007199254741003"}}\r\n'
        complete = b'{"checkpoint_complete":{"last_op_id":"9007199254741003"}}\n'
        wire = b"\n" + control + data_line(operations) + complete
        expected = [control[:-2].decode()] + [
            (b'{"data":{"bucket":' + json.dumps('badge["owner"]').encode()
             + b',"data":[' + encoded(op) + b']}}').decode() for op in operations
        ] + [complete[:-1].decode()]
        for size in (1, 2, 7, 31, 511, 512):
            with self.subTest(fragment_size=size):
                self.assertEqual(drain(wire, size), expected)

    def test_empty_array_and_bounded_metadata_order(self):
        self.assertEqual(drain(data_line([]), 1), [])
        wire = b'{"data":{"after":null,"bucket":"b","extra":{"a":[1,true]},"data":[],"has_more":false}}\n'
        self.assertEqual(drain(wire, 3), [])

    def test_megabyte_service_line_retains_only_one_operation_and_fragment(self):
        operations = [operation(i, padding="x" * 300) for i in range(2500)]
        wire = data_line(operations)
        self.assertGreater(len(wire), 1024 * 1024)
        parser = StreamLines()
        count, peak = 0, 0
        for offset in range(0, len(wire), MAX_FRAGMENT):
            parser.feed(wire[offset:offset + MAX_FRAGMENT])
            while True:
                line = parser.pop()
                retained = len(parser.pending) + len(parser.prefix) + len(parser.token) + len(parser.data_prefix or b"")
                peak = max(peak, retained)
                self.assertLessEqual(retained, MAX_LINE + MAX_FRAGMENT + MAX_METADATA)
                if line is None:
                    break
                value = json.loads(line)["data"]
                self.assertEqual(value["data"], [operations[count]])
                self.assertLessEqual(len(line.encode()), MAX_LINE)
                count += 1
        parser.finish()
        self.assertEqual(count, len(operations))
        self.assertLess(peak, 2048)

    def test_oversized_values_and_nesting_are_rejected(self):
        cases = [data_line([operation(0, padding="x" * MAX_LINE)]),
                 encoded({"checkpoint": {"extra": "x" * MAX_LINE}}) + b"\n",
                 encoded({"data": {"bucket": "b" * (MAX_METADATA + 1), "data": []}}) + b"\n",
                 b'{"checkpoint":' + b'[' * 17 + b'0' + b']' * 17 + b'}\n',
                 b'{"data":{"bucket":"b","data":[{"deep":' + b'[' * 17 + b'0' + b']' * 17 + b'}]}}\n']
        for wire in cases:
            with self.subTest(prefix=wire[:40]), self.assertRaises(ValueError):
                drain(wire, 7)

    def test_truncated_operation_envelope_and_control_are_rejected_at_eof(self):
        complete = data_line([operation(0, padding='slash \\ quote "')])
        cases = [b'{"checkpoint":', b'{"data":{"bucket":"b","data":[{"text":"unfinished\\',
                 complete[:-1], complete[:-3], complete[:len(complete) // 2]]
        for wire in cases:
            with self.subTest(prefix=wire[:40]), self.assertRaises(OSError):
                drain(wire, 1)

    def test_emitted_operation_does_not_allow_completion_past_truncated_suffix(self):
        parser = StreamLines()
        records = []
        wire = data_line([operation(0)])[:-3] + b'\n{"checkpoint_complete":{"last_op_id":"1"}}\n'
        with self.assertRaises(ValueError):
            for offset in range(0, len(wire), 7):
                parser.feed(wire[offset:offset + 7])
                while True:
                    line = parser.pop()
                    if line is None:
                        break
                    records.append(json.loads(line))
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["data"]["data"], [operation(0)])
        self.assertFalse(any("checkpoint_complete" in value for value in records))

    def test_malformed_json_never_emits_checkpoint_completion(self):
        cases = [b'{"data":{"bucket":"b","data":[{},]}}\n',
                 b'{"data":{"bucket":"b","data":[{} {}]}}\n',
                 b'{"data":{"bucket":"b","data":[1]}}\n',
                 b'{"data":{"data":[{}],"bucket":"b"}}\n',
                 b'{"data":{"bucket":"b","bucket":"c","data":[]}}\n',
                 b'{"data":{"bucket":"b","data":[],"data":[]}}\n',
                 b'{"data":{"bucket":"b","data":null}}\n',
                 b'{"data":{"bucket":"b"}}\n',
                 b'{"data":{"bucket":"b","data":[],}}\n',
                 b'{"data":{"bucket":"b","data":[]},"checkpoint_complete":{}}\n',
                 b'{"data":{"bucket":"b","data":[{"text":"literal\nnewline"}]}}\n',
                 b'{"data":{"bucket":"b","data":[{"text":"\\q"}]}}\n',
                 b'{"data":{"bucket":"b","data":[]}}junk\n']
        for wire in cases:
            with self.subTest(wire=wire), self.assertRaises(ValueError):
                drain(wire, 1)

    def test_input_is_bounded_and_cannot_replace_unread_data(self):
        parser = StreamLines()
        with self.assertRaises(ValueError):
            parser.feed(b"x" * (MAX_FRAGMENT + 1))
        parser.feed(b'{"token_expires_in":120}\n{"token_expires_in":119}\n')
        self.assertEqual(parser.pop(), '{"token_expires_in":120}')
        with self.assertRaises(ValueError):
            parser.feed(b"replacement")
        self.assertEqual(parser.pop(), '{"token_expires_in":119}')
        self.assertIsNone(parser.pop())
        parser.finish()


class RealCoreHistoryTests(unittest.TestCase):
    def test_28_history_operations_apply_only_at_the_real_checkpoint(self):
        from test_storage import HostCore, HOST_LIBRARY, storage
        from test_pairing import IDENTITY, Memory, Entropy, GatewayFake, StreamFake, PENDING
        from badgegotchi_sync import Sync, UploadQueue
        if not HOST_LIBRARY.exists():
            self.skipTest("Build pinned real-core host qualifier first")
        with tempfile.TemporaryDirectory() as directory:
            store = storage.Store(native=HostCore(), root=directory + "/badge")
            store.open()
            sync = None
            try:
                identity = dict(IDENTITY, owner_id="11111111-1111-4111-8111-111111111111",
                                device_id="22222222-2222-4222-8222-222222222222")
                queue = UploadQueue(identity, Entropy(), Memory({"owner_id": identity["owner_id"],
                    "device_id": identity["device_id"], "events": [], "inflight": None}))
                token = dict(identity, token="fixture", endpoint="https://sync.example")
                checkpoints = []
                def checkpoint_factory(*args, **kwargs):
                    remote = GatewayFake([{"data": {"checkpoint_request_id":
                        "9007199254740993" if not checkpoints else "9007199254740994"}}])
                    checkpoints.append(remote)
                    return remote
                operations = [operation(i, padding="bounded history " * 20) for i in range(28)]
                last = operations[-1]["op_id"]
                wire = encoded({"checkpoint": {"last_op_id": last, "write_checkpoint": "9007199254740994",
                    "buckets": [{"bucket": 'badge["owner"]', "checksum": sum(range(1, 29)),
                                 "priority": 3, "count": 28}]}}) + b"\n"
                history = data_line(operations)
                self.assertGreater(len(history), MAX_LINE)
                wire += history + encoded({"checkpoint_complete": {"last_op_id": last}}) + b"\n"
                class HistoryStream(StreamFake):
                    def __init__(self, *args, **kwargs):
                        super().__init__(*args, **kwargs)
                        self.parts = [wire[i:i + MAX_FRAGMENT] for i in range(0, len(wire), MAX_FRAGMENT)] + [PENDING]
                native_lines = []
                control = store.control
                def observed_control(command, payload=None):
                    if command == "line_text":
                        native_lines.append(payload)
                    return control(command, payload)
                store.control = observed_control
                sync = Sync(store, identity, queue, GatewayFake([token]), "https://sync.example", ("ca",),
                            http_factory=HistoryStream, json_factory=checkpoint_factory)
                for _ in range(200):
                    before = len(native_lines)
                    sync.step()
                    self.assertLessEqual(len(native_lines) - before, 1)
                    self.assertNotEqual(sync.phase, "blocked")
                    if sync.synced:
                        break
                    self.assertEqual(store.projection(), [])
                self.assertTrue(sync.synced)
                received = [json.loads(line)["data"]["data"] for line in native_lines if "data" in json.loads(line)]
                self.assertEqual(received, [[op] for op in operations])
                self.assertTrue(all(len(line.encode()) <= MAX_LINE for line in native_lines))
                self.assertEqual(store.projection()[0]["payload"]["hydration_count"], 27)
                self.assertEqual(store._scalar("SELECT count(*) FROM ps_crud"), "0")
                self.assertEqual(store._scalar("PRAGMA integrity_check"), "ok")
                self.assertLess(int(store._scalar("PRAGMA page_count")), storage.MAX_SYNC_PAGES)
            finally:
                if sync is not None:
                    sync.close()
                store.close()


if __name__ == "__main__":
    unittest.main()
