"""Pair once, reconnect automatically. Badgeware owns launcher and Home."""

import badgeware
import machine
from time import ticks_ms, ticks_diff, sleep_ms


exit_requested = False
home_pin = machine.Pin.board.BUTTON_HOME


def request_exit(_pin=None):
    # Badgeware's normal Home IRQ resets immediately. A flag keeps SQL and
    # filesystem cleanup in the foreground, even if Home arrives during SQL.
    global exit_requested
    exit_requested = True


home_pin.irq(trigger=machine.Pin.IRQ_FALLING, handler=request_exit)

from badgegotchi_view import AppView
from badgegotchi_storage import Store
from badgegotchi_client import Client


badge.mode(HIRES | VSYNC)
watchdog = machine.WDT(timeout=16000)
view = AppView(screen, color, font, image, rect, "assets/animals")
view.message("Getting ready", "Opening your account link and synced data.")
badgeware.display.update()
watchdog.feed()
store = Store(heartbeat=watchdog.feed)
state = None
client = None
failure = None
failure_title = "Could not open"
storage_ok = False

try:
    store.open()
    storage_ok = True
    client = Client(store, heartbeat=watchdog.feed)
    state = client.state
except Exception as exc:
    print("BADGEGOTCHI_OPEN_ERROR", type(exc).__name__, str(exc))
    failure = "This badge could not open its account data. Press Home to exit."

last_tick = ticks_ms()


def update():
    global last_tick, failure, failure_title, storage_ok
    watchdog.feed()
    if exit_requested:
        return True
    now = ticks_ms()
    elapsed = ticks_diff(now, last_tick)
    last_tick = now
    if failure is not None:
        view.message(failure_title, failure, error=True)
        return
    physical = [name for button, name in ((BUTTON_A, "A"), (BUTTON_B, "B"),
                 (BUTTON_C, "C"), (BUTTON_UP, "UP"), (BUTTON_DOWN, "DOWN")) if badge.held(button)]
    try:
        client.step(physical, elapsed)
    except Exception as exc:
        print("BADGEGOTCHI_LINK_ERROR", type(exc).__name__)
        failure_title = "Account link unavailable"
        failure = "Saved progress and pairing data are retained. Press Home to exit."
        view.message(failure_title, failure, error=True)
        return
    if exit_requested:
        return True
    if client.ready:
        view.draw(state, client)
    else:
        view.pairing(client)


def on_exit():
    # launch() calls this again after the module body returns. Cleanup belongs
    # solely to the foreground finally block; this hook never re-enters SQL.
    return None


def closed_home(_pin):
    badgeware.reset()


try:
    run(update)
finally:
    # Badgeware resets back to its existing launcher after the app returns.
    # Closing is mandatory; a storage failure must never trigger a fresh DB.
    try:
        if client is not None:
            client.close()
    finally:
        store.close()

if exit_requested:
    view.message("Returning home", "Release Home to return to the launcher.")
    badgeware.display.update()
    # HOME is also BOOT, so resetting while it is held enters the bootloader.
    while not home_pin.value():
        watchdog.feed()
        sleep_ms(10)
    badgeware.reset()
else:
    # Bounded diagnostic runs may return normally. Their DB is closed, and
    # Home should continue to work until Badgeware's next app installs its IRQ.
    home_pin.irq(trigger=machine.Pin.IRQ_FALLING, handler=closed_home)
