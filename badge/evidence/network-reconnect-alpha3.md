# Badgeware Wi-Fi reconnect source audit

Read-only audit on 2026-10-20 of the connected Tufty 2350 at
`/dev/cu.usbmodem1101`, using the installed mpremote 1.29.0 with `resume`.
Only the three public program files below were copied to temporary host storage.
No credential files were opened, no settings were written, and no disconnect,
Wi-Fi configuration change, app installation, or firmware flash was performed.

| Installed file | SHA-256 |
| --- | --- |
| `/system/main.py` | `d076b8ba48971678abe12507ce20a85979cff8a2fa702ce4c18ba15c9373852d` |
| `/system/lib/network_runtime.mpy` | `e371d2b24612cddb4d9fd14c2279f5f502db723bc52a0d24efdbfb27666de120` |
| `/system/lib/resilient_wifi.mpy` | `f6e8cdd7eaa64bdffc4c5dc5139423099583c4f0061019c04ee7f372c511ff72` |

The `.mpy` files were disassembled with the repository's pinned MicroPython
`41d1e007537f9b15cf13a9436228dd59d6485eca/tools/mpy-tool.py -d`.
This audit uses actual installed program bytes; module names alone were not
treated as evidence of reconnection behavior.

## Verified control flow

1. `/system/main.py` calls `network_runtime.install(run_function=run, ...)`
   before launching the menu or selected application.
2. `install` stores the service as `builtins.badgelink_network` and replaces
   `builtins.run` with `managed_run`.
3. Ordinary `managed_run` wraps the application update callback. Its
   `managed_update` calls the application's update, then calls
   `NetworkService.poll(exit_frame=...)` each frame. Runs with an explicit
   `duration` argument instead quiesce the network service for that diagnostic
   run and resume it afterward.
4. `NetworkService.poll` respects the saved enabled state and invokes the
   existing backend's `poll`. It owns other Badgeware network facilities too;
   constructing a second instance is inappropriate for this application.
5. `DeviceBackend.poll` calls its `ResilientWiFi.tick(now)`. The Wi-Fi state
   machine checks `wlan.isconnected()`, detects connection loss from `ONLINE`,
   enters failure/backoff, and when due calls `_begin` to request another
   `wlan.connect` with its already-managed configuration. It polls connection
   status and deadlines rather than sleeping in a connection loop.
6. Badgegotchi continues using the launcher-provided `run(update)` without
   a `duration` argument. Its pairing and sync clients make one cooperative
   network step per update and return while offline, allowing the existing
   manager to run. Network failures preserve credentials and queued events;
   sync attempts retry with bounded exponential backoff after Wi-Fi returns.

No duplicate Wi-Fi manager, direct credential import, radio-power toggle,
blocking connection loop, or network preference write was added to Badgegotchi.
If networking is disabled in Badgeware settings, that preference remains in
force. A launcher/runtime installation failure still prevents automatic Wi-Fi
reconnection; the app does not silently replace the manager.

## Evidence limits

The current diagnostic REPL reported `RUN_NAME=None` and
`MANAGED_NETWORK_PRESENT=False`. That session was not running `/system/main.py`,
so these values neither prove nor disprove the normal launch path. The source
above establishes the normal launch behavior only if installation succeeds.

No forced radio drop, reconnection timing measurement, Home-during-reconnect
device test, or live authenticated PowerSync recovery test was performed in
this audit. The existing manager's driver call latency was not requalified.
Host tests cover Badgegotchi's offline retry, retained pending work, and Home
cleanup; they do not establish physical Wi-Fi recovery. A second mocked copy
of the installed manager was deliberately not used as a substitute for that
device evidence.
