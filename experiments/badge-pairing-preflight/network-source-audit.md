# Badgeware network source audit — 2026-10-20

Scope: read-only local/upstream source review; this reviewer did not access the device, change firmware, connect a service, or modify repository files. Runtime observations below are attributed to the main agent. Source support is not proof that the installed binary has identical configuration or that a feature passed on the device.

## Finding and qualification boundary

The existing firmware has plausible app-level APIs for verified, cooperative HTTPS. No firmware replacement is justified by this source review. Credential creation/transmission remains gated on a qualified entropy path and trustworthy clock policy, plus the main agent's actual TLS negative tests and responsiveness results.

- **Observed by main agent:** `ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT).verify_mode == 0` on the unchanged badge. The installed Wi-Fi interface is active/connected and the RTC reports a plausible date. These observations do not establish certificate verification, trusted time bootstrap, or cryptographic entropy.
- **Source explanation:** the pinned Python `ssl` compatibility wrapper explicitly overwrites the underlying context with `CERT_NONE`. Set `CERT_REQUIRED` explicitly and verify its effective value. The underlying `tls.SSLContext` client defaults to required verification, but relying on that default through `ssl` is unsafe.
- **Entropy blocker:** `os.urandom` and the Mbed TLS entropy callback both reach the SDK's `get_rand_64`. In the referenced SDK, raw hardware TRNG samples are mixed through SplitMix64 into a xoroshiro128** state; TRNG checks and decorrelators are bypassed. This review has not established the entropy quality or a security guarantee appropriate to two independent persistent 256-bit credentials. Sample uniqueness/random-looking bytes cannot close that gap. Mbed TLS has a CTR-DRBG, but its source entropy still requires qualification. Successful certificate validation alone therefore cannot complete secure TLS qualification.
- **Cancellation blocker:** plain `socket.getaddrinfo` and the default TLS wrapping handshake have internal blocking loops. A socket timeout does not make DNS bounded at the Python/app layer. Nonblocking I/O permits cooperative waits, but a single cryptographic call can still stall; measure its maximum duration.

## Exact provenance

The previously qualified native ABI identified runtime tag `bw-1.29.0-gc` / MicroPython revision `41d1e007537f9b15cf13a9436228dd59d6485eca`. `experiments/badgeware-native/README.md` states that the exact full firmware Git identity was not exposed. The recorded source archive SHA-256 is `78e2a572f6048c80d1fbd65aa9149127eb145b42c54264c4d20580f838f03821`.

Public GitHub contents API queries for that MicroPython revision returned:

- [`lib/pico-sdk`](https://api.github.com/repos/pimoroni/micropython/contents/lib/pico-sdk?ref=41d1e007537f9b15cf13a9436228dd59d6485eca): `98a542c1a62fb549ffb5d66a3e5892b06276b670`.
- [`lib/micropython-lib`](https://api.github.com/repos/pimoroni/micropython/contents/lib/micropython-lib?ref=41d1e007537f9b15cf13a9436228dd59d6485eca): `ee4bb8ff139e24c42b739935fbd8ec7c4d061e02`.

These are the source revision's dependencies, not an independently proven installed firmware build manifest. Compiler options or custom overrides remain unknown.

| Pinned source | Relevant evidence | SHA-256 |
| --- | --- | --- |
| [ssl.py](https://raw.githubusercontent.com/micropython/micropython-lib/ee4bb8ff139e24c42b739935fbd8ec7c4d061e02/python-stdlib/ssl/ssl.py) | Lines 5–8: wrapper sets `CERT_NONE`; 27–40: CA loading and hostname/handshake arguments pass through | `e2b12a4dac5504f567e316d7f48ec69a8f6e5fd8ad47c90a9ee69fd4a0f78f4a` |
| [SDK rand.c](https://raw.githubusercontent.com/raspberrypi/pico-sdk/98a542c1a62fb549ffb5d66a3e5892b06276b670/src/rp2_common/pico_rand/rand.c) | Lines 153–155: checks/decorrelators bypassed; 329–381: entropy mixing and xoroshiro128** output | `03ff3129ef1d50a8d971b45d0b35e61388bbbdc9773dbf4118945e25c6261c97` |
| [SDK rand.h](https://raw.githubusercontent.com/raspberrypi/pico-sdk/98a542c1a62fb549ffb5d66a3e5892b06276b670/src/rp2_common/pico_rand/include/pico/rand.h) | Lines 21–26: output described as PRNG; 73–77: TRNG source enabled by default when available | `aed11722207256d9ec9865e63cd7f716f7848fe57d9d053b0b2741bb8a13f2e9` |

The following paths are relative to the local source directory:

`/Users/kobie/projects/powersync/skunkworks/badgegotchi/experiments/badgeware-native/vendor/micropython-41d1e007537f9b15cf13a9436228dd59d6485eca/`

Their upstream base is `https://raw.githubusercontent.com/pimoroni/micropython/41d1e007537f9b15cf13a9436228dd59d6485eca/`.

| Path | Relevant evidence | SHA-256 |
| --- | --- | --- |
| `extmod/modtls_mbedtls.c` | Client default REQUIRED: 330; CA parsing: 515; hostname/SNI required: 785; synchronous handshake loop: 818; cipher/version: 865; nonblocking read/write: 878; poll masks and close cleanup: 965 | `681c6bb8246bc6a674762513b63c087142cdd72d4bc514e138420d67644b5326` |
| `extmod/modlwip.c` | DNS wait loops over `poll_sockets()` without app deadline: 1866–1880 | `6bc29d1e70f4f0536324b502212d3de6cfe8c5f28b1c73a6127f742c3be151bc` |
| `extmod/modos.c` | `os.urandom` calls `mp_hal_get_random`: 149–159 | `16c63656af2700afb148a51edb2f8a103c4da5586d9a4991b7719734f3679050` |
| `extmod/mbedtls/mbedtls_alt.c` | `mbedtls_hardware_poll` calls the same randomness hook: 98–103 | `cd88c26cd09da8bfd506be69b2bf2a77368cd06a59f0825f72453b478cafe0b1` |
| `ports/rp2/mphalport.c` | `mp_hal_get_random` copies successive `get_rand_64` outputs: 281–286 | `9269bf9f476ca4112aef7dacfb8856d0c665900b2532e8a853e9ddf2fb814eb3` |
| `ports/rp2/mbedtls/mbedtls_port.c` | TLS wall time comes from AON timer/RTC: 38–42 | `9b88b3f95f6385770a8bbb24720226e6431e65a2a64773bfecea0aca71c5a172` |
| `ports/rp2/mbedtls/mbedtls_config_port.h` | Time hook and shared TLS configuration | `028231d666570d46899c23db1b0b8ddebd73cd1dfcd30cd6c642fc26ba689060` |
| `extmod/mbedtls/mbedtls_config_common.h` | Date checks: 36–37; TLS 1.2: 59; AES-GCM: 80; buffers 16 KiB inbound/4 KiB outbound: 63–65 | `7a923d3df9762e6e74973b6313fd381a6667f42ae107e291d964c748e9094274` |

To reproduce the source audit, retrieve the two submodule metadata URLs above, download the three pinned raw sources, hash their exact bytes with SHA-256, and inspect the listed lines. Hash local sources with `shasum -a 256 PATH`. No device operation or repository update is needed.

## Safe path on the unchanged firmware

1. Keep the existing connected Wi-Fi configuration. The previous installed inventory (`badge/evidence/device-after-alpha2.txt:11`) contains `verified_tls`, `bounded_dns`, `resilient_wifi`, `network_runtime`, `clock_boot`, radio/network preferences and `/system/lib/ca`. Main-agent introspection found stepped DNS APIs and `VerifiedTLSShim`. Names and API existence are not behavioral proof: inspect public module code and side effects before reuse; do not read/log credential values or change shared preferences.
2. Run only credential-free HTTPS diagnostics until security gates pass. Load an explicit appropriate CA, assign and assert `CERT_REQUIRED`, pass the real expected hostname, and test real Supabase/PowerSync hosts. Do not follow cross-origin redirects or print response secrets. Record actual cipher/version, bounded HTTP status/body handling, cleanup and reconnect.
3. Prove wrong-host, untrusted-chain and expired-certificate rejection. Use an expired-certificate server fixture rather than changing RTC; RTC mutation could affect retained timer behavior. A plausible RTC value is not evidence of trustworthy time across resets or clock adjustments.
4. Audit/use a stepped bounded DNS resolver; configure raw sockets nonblocking and wrap with `do_handshake_on_connect=False`. Drive bounded reads/writes from the foreground app loop, respecting partial I/O and WANT_READ/WANT_WRITE. Use deadlines and byte/header/body limits; measure the longest individual step and combined native/Python memory.
5. On Home/cancellation, stop the operation and close the entire TLS/raw socket before database cleanup and launcher return. Test cancellation while actual work is pending, followed by a fresh connection. Badgegotchi currently sets an IRQ flag and performs cleanup in foreground; blocking calls delay that cleanup.
6. Resolve the precise entropy contract/provenance before generating enrollment secrets. Continue app-level transport and state-machine work with explicit blocked enrollment meanwhile; do not silently replace the RNG with `random`, timestamps, IDs, or statistically tested bytes. This review does not require or propose a firmware change.

The separate standalone-firmware HTTPS experiments in sibling `powerbadge` do not qualify the installed Badgeware stack. This audit also does not establish live PowerSync, enrollment, durable credential storage, background operation, or combined TLS/core UI responsiveness.
