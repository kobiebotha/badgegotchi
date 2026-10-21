"""Condition the supported RP2350 platform RNG before creating app secrets.

Trust boundary: the pinned stock Badgeware/RP2350 build and working hardware
TRNG. See experiments/badge-pairing-preflight/entropy-review.md.
This is not entropy certification.
Each call collects a new 1536-byte stream, then applies SHA-256; never seed from
clocks, unique IDs, Python random, or a shared secret embedded in the package.
"""
import hashlib
import os

_SAMPLE_BYTES = 1536
_DOMAIN = b"badgegotchi:rp2350:credential-random:v1\x00"
_last_digest = None


def secret_bytes(size):
    global _last_digest
    if type(size) is not int or not 1 <= size <= 32:
        raise ValueError("Invalid secure-random request")
    sample = os.urandom(_SAMPLE_BYTES)
    if not isinstance(sample, bytes) or len(sample) != _SAMPLE_BYTES:
        raise ValueError("Badge randomness unavailable")
    # Reject obvious failed-source outputs. This is an error check, not a
    # statistical test or an estimate of input entropy.
    if sample == sample[:8] * (_SAMPLE_BYTES // 8):
        raise ValueError("Badge randomness source failed")
    value = hashlib.sha256(_DOMAIN + sample).digest()
    if value == _last_digest:
        raise ValueError("Badge randomness source repeated")
    _last_digest = value
    return value[:size]
