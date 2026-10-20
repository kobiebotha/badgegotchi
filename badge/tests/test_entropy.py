"""RNG adapter behavior tests, not entropy estimates or randomness tests."""
import hashlib
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('badgegotchi_entropy', ROOT / 'badge/app/badgegotchi/badgegotchi_entropy.py')
entropy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(entropy)

class EntropyTests(unittest.TestCase):
    def setUp(self):
        entropy._last_digest = None

    def test_conditions_each_fresh_draw_without_time_or_seed(self):
        samples = [bytes(range(256)) * 6, bytes(reversed(range(256))) * 6]
        with patch.object(entropy.os, 'urandom', side_effect=samples) as source:
            for sample in samples:
                self.assertEqual(entropy.secret_bytes(32), hashlib.sha256(entropy._DOMAIN + sample).digest())
            self.assertEqual(source.call_count, 2)
            source.assert_called_with(1536)

    def test_short_failed_repeated_source_fails_closed(self):
        for sample in (b'', b'x'*1536, b'12345678'*192):
            with self.subTest(size=len(sample)), patch.object(entropy.os, 'urandom', return_value=sample):
                with self.assertRaises(ValueError):
                    entropy.secret_bytes(32)
        with patch.object(entropy.os, 'urandom', return_value=bytes(range(256))*6):
            entropy.secret_bytes(32)
            with self.assertRaisesRegex(ValueError, 'repeated'):
                entropy.secret_bytes(32)

    def test_uuid_draw_is_fresh_and_invalid_request_does_not_touch_rng(self):
        with patch.object(entropy.os, 'urandom', return_value=bytes(range(256))*6) as source:
            self.assertEqual(len(entropy.secret_bytes(16)), 16)
            for size in (0, 33, -1, True, '32'):
                with self.assertRaises(ValueError):
                    entropy.secret_bytes(size)
            self.assertEqual(source.call_count, 1)

if __name__ == '__main__':
    unittest.main()
