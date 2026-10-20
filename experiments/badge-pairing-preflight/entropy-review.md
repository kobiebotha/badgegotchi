# Credential entropy review follow-up

2026-10-20. Read-only source review for the unchanged RP2350 Badgeware prototype.
This refines the entropy conclusion in [network-source-audit.md](network-source-audit.md).
It does not report a device test, firmware change, deployment, or cryptographic
certification.

## Engineering conclusion

For this prototype, `SHA256(domain || os.urandom(1536))`, with a fresh complete
draw for each 32-byte secret and an app/version domain prefix, is a reasonable
conditioning design **under the ordinary trust assumption that the identified
stock firmware and working RP2350 hardware use the inspected default RNG path**.
The earlier blanket block based on disabled TRNG checks was too strict. Disabling
those checks is an intentional manufacturer design choice; it is not, by itself,
evidence that the source lacks useful entropy.

The Raspberry Pi [RP2350 datasheet, sections 12.12.4.1–2](https://pip-assets.raspberrypi.com/categories/1214-rp2350/documents/RP-008373-DS-2-rp2350-datasheet.pdf?disposition=inline)
describes the bootrom bypassing internal TRNG checks and conditioning, then
feeding 25 blocks containing 9,600 raw oscillator samples into SHA-256. The SDK
instead mixes raw TRNG samples with SplitMix64 and xoroshiro128**. Additional
SHA-256 conditioning follows the manufacturer's general approach; applying it
to SDK output is **not the identical bootrom construction**.

One 1,536-byte MicroPython draw makes 192 `get_rand_64()` calls. With the default
RP2350 configuration, those calls consume 12,288 fresh TRNG sample bits across
successive hardware batches. This is a conservative sampling budget relative
to the bootrom example, not a measurement of min-entropy. SDK mixing and state
transitions mean raw sample counts are not an entropy guarantee or a proof that
every requested sample influences the same digest. Fresh input on successive
calls also means the 128-bit PRNG state alone does not establish a 128-bit cap
on entropy across the entire collected output stream.

## Source evidence and limits

The vendor root below is
`experiments/badgeware-native/vendor/micropython-41d1e007537f9b15cf13a9436228dd59d6485eca/`:

- `extmod/modos.c:149`: `os.urandom` uses `mp_hal_get_random`.
- `ports/rp2/mphalport.c:281`: each eight output bytes comes from a new
  `get_rand_64()` call.
- Pinned [SDK rand.c](https://raw.githubusercontent.com/raspberrypi/pico-sdk/98a542c1a62fb549ffb5d66a3e5892b06276b670/src/rp2_common/pico_rand/rand.c):
  lines 139–179 consume hardware samples; lines 329–381 mix runtime sources and
  emit PRNG output.
- Pinned [SDK rand.h](https://raw.githubusercontent.com/raspberrypi/pico-sdk/98a542c1a62fb549ffb5d66a3e5892b06276b670/src/rp2_common/pico_rand/include/pico/rand.h):
  lines 73–77 enable TRNG input by default when the hardware is available.
- `rg --hidden --no-ignore -n 'PICO_RAND_|HAS_RP2350_TRNG'` found no overrides
  anywhere in the inspected vendored MicroPython tree. This does not cover
  unrecorded compiler arguments, external board configuration, or custom binary
  modifications. Matching runtime version/ABI is not proof of the exact binary
  build configuration.

The pinned SDK sources were retrieved again; SHA-256 hashes match the earlier
audit: rand.c `03ff3129ef1d50a8d971b45d0b35e61388bbbdc9773dbf4118945e25c6261c97`,
rand.h `aed11722207256d9ec9865e63cd7f716f7848fe57d9d053b0b2741bb8a13f2e9`.

## Required implementation behavior

Use separate fresh draws for pending and candidate credentials, app/version
domain separation, and the full SHA-256 digest. The current adapter uses one
domain prefix for these separate draws, not distinct labels for each purpose.
Fail on unavailable APIs, wrong
lengths, or runtime identity outside the reviewed stock configuration. Never
fall back to clocks, board IDs, `random`, or reused input. Preserve enrollment
secrets atomically before transmission; never emit raw samples or credentials
into logs, URLs, test reports, or distributable packages. Tests should establish
these behaviors and on-device latency, not claim that sample uniqueness proves
unpredictability.

[NIST SP 800-90B, sections 2.2 and 3.1.5](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/nist.sp.800-90b.pdf)
explains that deterministic conditioning cannot create missing entropy. Therefore
this review does not claim measured 256-bit min-entropy, statistically independent
physical draws, FIPS validation, fault detection, or resistance to physical
oscillator manipulation. The inference is source-informed engineering assurance
for the stated stock-platform trust model.

TLS retains its own RNG path. In the vendor tree,
`extmod/mbedtls/mbedtls_alt.c:98` feeds the same platform hook to Mbed TLS entropy;
`extmod/modtls_mbedtls.c:319` seeds CTR-DRBG and line 337 supplies its output to
TLS. Application credential conditioning does not modify or independently
qualify TLS randomness. TLS continues to rely on the audited stock-platform
assumption alongside the separate certificate/hostname validation tests.
