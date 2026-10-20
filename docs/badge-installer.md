# Badgeware app installer

`/install` installs an ordinary Badgeware app under `apps/badgegotchi`. It serves
an app ZIP and, when the browser supports a directory picker, copies and verifies
the app files on the Badgeware USB file drive. The original firmware, launcher,
other apps, and existing data remain in place.

This is a local companion alpha for Pimoroni Tufty 2350, qualified with Badgeware
`bw-1.29.0-gc` and native MicroPython ABI `_mpy == 7942`. It uses real SQLite and
PowerSync core. Cloud sync, account pairing, Wi-Fi provisioning, and AI
conversations are separate work and are not available in this release.

## Installation

1. Start with the normal Badgeware launcher and connect a USB data cable.
2. Double-tap **RESET** to enter Badgeware USB file mode. The drive must contain
   an existing `apps` directory. Do not use the `RP2350` BOOTSEL drive.
3. Open `/install`. The page downloads and verifies the release ZIP and every app
   file before enabling installation.
4. In a browser with directory access, choose the Badgeware drive itself, then
   choose **Copy app to badge**. The browser checks the copied files individually.
   If directory access is unavailable or denied, choose **Download verified app ZIP**,
   extract it on the computer, and copy the extracted `apps/badgegotchi` directory
   into the badge's existing `apps` directory. Copy only the `badgegotchi` folder;
   do not replace or merge the whole `apps` directory.
5. Wait for copying to finish. Safely eject the file drive, press **RESET** once,
   and open **Badgegotchi** in the normal launcher.

The browser installer refuses an existing `apps/badgegotchi` entry, including case
variants. It does not implement updates. Manual-copy users must likewise stop if
that directory exists. The separately qualified developer update tool checks the
old app against its ZIP and retains host and device backups; see the
[app documentation](../badge/README.md).

A ZIP download does not report that an app was installed. The browser copy reports
**App copied and verified** only after every file passes readback. Both paths
still require ejecting the drive and launching the app. Browser readback is not
proof against power loss or a substitute for safe ejection. The folder picker
cannot establish the board identity or inspect the installed runtime; the app
checks native compatibility before loading it.

If a drive contains `INFO_UF2.TXT` or is named `RP2350`, `RP2`, or `RPI-RP2`, the
browser rejects it. Press RESET once to return to Badgeware, then double-tap RESET
to open its file drive. The installer never copies a UF2 file or flashes firmware.

## Copy boundaries and failure handling

- The manifest fixes `appId`, board, native ABI, and launcher entry name. Relative
  paths reject traversal, absolute paths, hidden segments, Windows device names,
  trailing dots, case aliases, and file/directory collisions. Artifact URLs must
  stay beneath the same-origin `/badge-app/` path with no query or escape segments.
- ZIP and file downloads have bounded sizes and SHA-256 checks. No drive is chosen
  until the entire package passes. Hashes establish consistency with the served
  manifest; they are not a digital signature.
- The selected drive must already contain `main.py` and `apps/menu`. The installer
  creates only a new `apps/badgegotchi` directory. It writes and reads back every
  dependency before writing `__init__.py`, which makes the app launchable.
- Browser copying requires Web Locks. An exclusive lock spans drive validation,
  writes, verification, and failure cleanup, so a concurrent installer in another
  tab on this origin is rejected before it changes files. A returned file handle
  must still be empty before it is considered created by this attempt; a nonempty
  file that appeared meanwhile is left unchanged and excluded from cleanup.
- On an ordinary write or readback error, cleanup visits only handles created by
  that attempt, checks entry identity, and uses nonrecursive removal. An unexpected
  file is retained and prevents its directory from being removed. A disconnect
  can prevent cleanup; the page reports that remnants may remain in the new app
  folder. Never remove another app or the drive's `state` folder to recover.
- Do not concurrently edit or copy files into `apps/badgegotchi` during installation.
  File System Access has no atomic exclusive directory creation. The implementation
  checks for existing entries and nonempty returned handles before writing, but cannot provide
  filesystem transactions against another process writing at the same instant.

## Building the package

From the repository root:

```sh
sh badge/native/build.sh
python3 badge/tools/package.py --stage-web
```

Packaging creates `badge/dist/badgegotchi-<version>-<sha12>.zip`, whose contents
are beneath `apps/badgegotchi/`, and stages
`web/public/badge-app/manifest.json`, the ZIP, and individual app files beneath
`web/public/badge-app/<version>-<sha12>/`. The manifest records the exact URLs.
Do not copy credentials, private networking experiments, or firmware build trees
into `web/public`.

Manifest contract:

```json
{
  "schemaVersion": 1,
  "release": {
    "version": "0.1.0-alpha.2",
    "appId": "badgegotchi",
    "name": "Badgegotchi",
    "board": "tufty2350",
    "runtimeMpy": 7942,
    "description": "Local companion alpha.",
    "zipUrl": "/badge-app/<release>/app.zip",
    "zipSha256": "<64 lowercase hexadecimal characters>",
    "zipBytes": 123456,
    "files": [
      {
        "path": "__init__.py",
        "url": "/badge-app/<release>/files/__init__.py",
        "bytes": 123,
        "sha256": "<64 lowercase hexadecimal characters>"
      }
    ]
  }
}
```

`release: null` represents an unpublished package. Releases are limited to 128
files and 16 MiB total uncompressed content; the ZIP has a separate 16 MiB bound.
Files must be nonempty, and the root `__init__.py` is required.

From `web`, run:

```sh
npm run app:check
npm test
npm run build
PLAYWRIGHT_CHANNEL=chrome npm run test:browser -- installer.spec.ts
```

`app:check` also runs before a build. It verifies the local manifest, every file,
and ZIP size and SHA-256, and refuses symlinks that resolve outside the staged
app directory. The package tool constructs the ZIP from the same app files.

The browser tests exercise download corruption, canceled selection, BOOTSEL and
wrong-folder rejection, existing-install refusal, preservation of other files,
readback corruption, write failure, and cleanup that retains unexpected files.
They use an in-memory drive; they do not validate a physical browser directory
picker or removable-drive caching. Physical install and launcher results should
be recorded with the exact package hash separately.

The older PICOBOOT/UF2 helpers and their tests remain as dormant prior work. They
are not imported by `/install` and are not part of the app release workflow.
Preparing or building this package does not deploy it. The owner handles Git
pushes, and a powersync Vercel deployment requires explicit approval.

## References

- [Badgeware native feasibility evidence](../experiments/badgeware-native/README.md)
- [Chrome File System Access API documentation](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)
- [Web Locks specification](https://www.w3.org/TR/web-locks/)
