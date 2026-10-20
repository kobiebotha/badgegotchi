# Badge installer

The web app installs a curated firmware release through the RP2350 ROM's
PICOBOOT interface using WebUSB. Vercel serves the installer, manifest, and UF2
as static assets; USB traffic stays between the browser and the connected badge.
Installation does not configure Wi-Fi or pair a badge with a signed-in account.
Those steps require corresponding firmware and backend support.

## Current release status

There is no qualified, permanently installable Badgegotchi firmware release yet.
The shipped manifest therefore has `release: null`. The installer shows setup
instructions, with USB connection and download disabled until a qualified
firmware artifact is prepared.

The existing `powerbadge` native experiments load into SRAM or PSRAM. They prove
separate SQLite, PowerSync-core, storage, and HTTPS capabilities; they are not an
integrated Badgegotchi firmware image. Resetting those experiments returns to
Badgeware. Renaming a diagnostic, changing its link address, or converting its
ELF to UF2 does not make it a permanent Badgegotchi application.

The WebUSB protocol implementation and error paths are tested with simulated
devices. A successful real browser installation and subsequent badge boot still
require physical hardware qualification. A verified transfer alone does not
prove that the installed application boots, connects, pairs, or syncs.

## User flow

1. Open the installer in a desktop Chromium browser that exposes WebUSB, such as
   Chrome or Edge, over HTTPS. `localhost` also works during development.
   Browser or organization policy may disable USB access.
2. Connect the **Tufty 2350** with a USB data cable.
3. Hold its rear **Boot** button, press and release **Reset**, then release
   **Boot**. This enters RP2350 BOOTSEL, which differs from Badgeware's ordinary
   USB disk mode.
4. Select the badge in the browser's device chooser. Check that the selected
   physical device is a Tufty 2350: its ROM identifies the RP2350 chip, not the
   board's manufacturer or wiring.
5. Once a qualified release is available, review its version and replacement
   notice, then start installation. Keep the cable connected through erase,
   programming, readback verification, and reboot.
6. Follow the setup shown by the installed firmware. Wi-Fi provisioning and
   account pairing are separate milestones.

Safari and Firefox users can use the same release's UF2 download fallback:
enter BOOTSEL, then drag the downloaded `.uf2` onto the badge's boot drive.
This uses the ROM's mass-storage installer rather than WebUSB. It does not
provide the browser installer's readback verification; check the firmware's
startup screen after the drive disconnects. Qualify this path on the exact
supported badge and ROM revision: older RP2350 ROMs may write the E10 workaround
block that newer ROMs ignore. If no firmware release is available, the fallback
download is unavailable too.

If a transfer fails, remain connected or re-enter BOOTSEL and retry the complete
installation. A partially programmed image may not boot normally. Never label
a canceled or interrupted transfer as a successful installation.

## Flash boundary

The initial installer targets one dedicated, ARM secure Tufty 2350 image:

| Constraint | Value |
| --- | --- |
| UF2 family | RP2350 ARM secure, `0xe48bff59` |
| Program page | 256 bytes |
| Erase sector | 4,096 bytes |
| Image start | `0x10000000` |
| Allowed firmware window | `0x10000000 <= address < 0x10f00000` |
| Preserved tail | `0x10f00000 <= address < 0x11000000` |

The first 15 MiB is the allowed firmware window; it is **not a preserved
region**. Erase and programming are limited to sectors required by the validated
image, with readback verification. The final 1 MiB is excluded from WebUSB
installer writes. This is a fixed initial layout, not arbitrary RP2350 partition
support. The firmware runtime and manual ROM installer need separate storage
qualification.

Dedicated Badgegotchi firmware replaces the existing Badgeware firmware and
launcher. Preserving the final 1 MiB does not promise that old apps still run,
that a new runtime understands the old filesystem, or that it preserves data
when it starts. Qualify the complete firmware's storage behavior separately.

Malformed UF2 files, wrong chip families, missing or repeated block numbers,
overlapping pages, unsupported payloads, or addresses outside the allowed
window are rejected before writing. The parser recognizes the canonical
picotool RP2350-E10 ignored dummy block as metadata rather than flash payload;
other absolute-address images are unsupported. No erase-all, OTP programming,
or arbitrary local-file upload is exposed to users.

## Preparing a real release

Prepare only an integrated firmware image that has been reviewed and qualified
for Tufty 2350. It must contain no Wi-Fi passwords, user tokens, device secrets,
or OpenAI key. Do not copy the existing networking experiment's private ELF
outputs or expose `powerbadge/dist` or its build directories as web assets.

From `badgegotchi/web`, using the project's supported Node.js version:

```sh
node --experimental-strip-types scripts/prepare-firmware.ts \
  --uf2 /absolute/path/to/qualified-badgegotchi.uf2 \
  --version 0.1.0 \
  --description "Initial Tufty 2350 release."
```

The command validates the UF2 using the browser installer's parser, computes
SHA-256, and stages:

```text
public/firmware/badgegotchi-<version>-<first-12-sha256-characters>.uf2
public/firmware/manifest.json
```

Version strings must match `[A-Za-z0-9][A-Za-z0-9._+-]{0,63}`. The description
is optional and limited to 500 characters. The artifact is created exclusively:
an existing identical file is accepted; different bytes at the same path are
rejected. The manifest is replaced atomically only after the artifact is fully
written. Retain earlier artifacts if any deployed manifest still references
them.

Manifest shape:

```json
{
  "schemaVersion": 1,
  "release": {
    "version": "0.1.0",
    "board": "tufty2350",
    "name": "Badgegotchi",
    "description": "Initial Tufty 2350 release.",
    "uf2Url": "/firmware/badgegotchi-0.1.0-<sha-prefix>.uf2",
    "sha256": "<64-lowercase-hex-characters>",
    "bytes": 123456
  }
}
```

This example is illustrative; it is not an installable manifest. Keep
`{"schemaVersion":1,"release":null}` until a real release passes qualification.
The browser validates the manifest, downloaded byte count, and full SHA-256
before parsing or writing. A digest protects artifact integrity relative to the
served manifest; it is not a firmware signature or a secure-boot implementation.

`scripts/check-firmware.ts` is the build guard. An unavailable release is valid;
an available release must have a valid manifest and a local artifact whose
size, SHA-256, and UF2 structure pass validation. It fails the build if an artifact
is missing or inconsistent. It does not execute firmware or establish hardware
compatibility.

Preparation does not deploy anything or contact the badge. Build and inspect
the resulting app locally. The owner handles Git pushes, and deployment to the
powersync Vercel organization requires the owner's approval.

## Physical qualification before publishing

Use a designated development badge and a known recovery image. Record the
firmware source revision, build command, UF2 SHA-256, board model, and browser
version with the test results.

- Verify BOOTSEL detection, the intended device selection, unsupported-browser
  behavior, and a canceled device chooser.
- Install the exact staged artifact. Require complete readback verification,
  reboot into the expected version, and a successful power-cycle boot.
- Compare the final 1 MiB before and after installation. Separately test the
  firmware's startup and runtime behavior against the intended persistent
  storage policy.
- Check interrupted-transfer recovery through BOOTSEL and the manual UF2
  fallback on the same artifact.
- Qualify Wi-Fi provisioning, device identity, account pairing, offline
  persistence, and PowerSync separately before claiming those capabilities.

## Primary references

- [Pimoroni Tufty 2350 firmware and BOOTSEL instructions](https://github.com/pimoroni/tufty2350)
- [Raspberry Pi PICOBOOT command definitions](https://github.com/raspberrypi/pico-sdk/blob/master/src/common/boot_picoboot_headers/include/boot/picoboot.h)
- [Raspberry Pi UF2 definitions and family identifiers](https://github.com/raspberrypi/pico-sdk/blob/master/src/common/boot_uf2_headers/include/boot/uf2.h)
- [RP2350 ROM handling of ignored UF2 blocks](https://github.com/raspberrypi/pico-bootrom-rp2350/blob/master/src/nsboot/usb_virtual_disk.c)
- [Official picotool implementation](https://github.com/raspberrypi/picotool)
- [WebUSB browser availability and secure-context requirements](https://developer.mozilla.org/en-US/docs/Web/API/WebUSB_API)
