"""Bounded installed-app launch and real-display bounds/capture qualification."""
import binascii
import builtins
import gc
import machine
import os
import sys
from time import ticks_ms, ticks_diff
import badgeware

APP = "/system/apps/badgegotchi"
sys.path.insert(0, APP)
import badgegotchi_view
from badgegotchi_state import AppState

watchdog = machine.WDT(timeout=16000)
original_run = run
original_view = badgegotchi_view.AppView
original_fatal = badgeware.fatal_error


def raise_error(title, detail):
    raise RuntimeError(str(title) + ": " + str(detail))


class CheckedScreen:
    @property
    def pen(self):
        return screen.pen

    @pen.setter
    def pen(self, value):
        screen.pen = value

    @property
    def font(self):
        return screen.font

    @font.setter
    def font(self, value):
        screen.font = value

    def clear(self):
        screen.clear()

    def rectangle(self, x, y, width, height):
        assert 0 <= x and x + width <= 320, (x, width)
        assert 0 <= y and y + height <= 240, (y, height)
        screen.rectangle(x, y, width, height)

    def circle(self, x, y, radius):
        assert radius <= x < 320 - radius
        assert radius <= y < 240 - radius
        screen.circle(x, y, radius)

    def measure_text(self, value, scale):
        return screen.measure_text(value, scale)

    def text(self, value, x, y, scale):
        width, height = screen.measure_text(value, scale)
        assert 0 <= x and x + width <= 320, (value, x, width)
        assert 0 <= y and y + height <= 240, (value, y, height)
        screen.text(value, x, y, scale)

    def blit(self, *args):
        screen.blit(*args)


def checked_view(_screen, *args):
    return original_view(CheckedScreen(), *args)


frames = [0]
frame_time_ms = [0]


def bounded_run(update):
    app = sys.modules[APP]
    assert app.storage_ok and app.failure is None, "App failed to open installed storage"
    assert app.store.version == "0.5.4/cratesio"
    started = ticks_ms()

    def frame():
        watchdog.feed()
        result = update()
        watchdog.feed()
        assert app.storage_ok and app.failure is None, "Installed app update failed"
        assert result is None, "Installed app exited before two healthy frames"
        # Count completed update/draw calls, including the first PNG load.
        # A total 250ms window can expire during that first frame on hardware.
        frames[0] += 1
        if frames[0] >= 2:
            return True

    try:
        badgeware._run(frame, duration=3000)
    finally:
        frame_time_ms[0] = ticks_diff(ticks_ms(), started)


try:
    builtins.run = bounded_run
    badgeware.fatal_error = raise_error
    badgegotchi_view.AppView = checked_view
    badgeware.launch(APP)
    assert frames[0] >= 2, ("Incomplete healthy frames", frames[0], frame_time_ms[0])
    print("INSTALLED_APP_LAUNCH_PASS", frames[0], "elapsed_ms", frame_time_ms[0])
finally:
    builtins.run = original_run
    badgegotchi_view.AppView = original_view
    badgeware.fatal_error = original_fatal

# Exercise account views without saving or uploading any simulated actions.
os.chdir(APP)


class AccountView:
    status = "SYNCED"
    pending_count = 0
    show_details = False


client = AccountView()
state = AppState(clock=lambda: 1792536000)
client.state = state
projection = {
    "pet": {"id": "11111111-1111-4111-8111-111111111111", "animal_id": "penguin",
            "name": "Penguin", "speech": "Your account follows you between the web and your badge."},
    "timer": {"revision": "0", "id": None, "type": "focus", "state": "idle",
              "planned_duration_seconds": 2400, "remaining_seconds_at_pause": 2400,
              "started_at": None, "last_resumed_at": None, "paused_at": None},
    "summary": {"day_key": "2026-10-20", "ended_focus_count": 0, "ended_break_count": 0,
                "hydration_count": 5, "movement_count": 1, "pet_count": 0},
}
view = original_view(CheckedScreen(), color, font, image, rect, "assets/animals")
state.refresh({}, [])
view.draw(state, client)
for animal_id in badgegotchi_view.ANIMALS:
    watchdog.feed()
    projection["pet"]["animal_id"] = animal_id
    state.refresh(projection, [])
    view.draw(state, client)
    gc.collect()
for value in (0, 999, 1000, 999999, 1000000):
    for name in ("ended_focus_count", "ended_break_count", "hydration_count", "movement_count", "pet_count"):
        projection["summary"][name] = value
    state.refresh(projection, [])
    for details in (False, True):
        client.show_details = details
        view.draw(state, client)
client.show_details = False
client.pending_count = 16
client.status = "UPLOADING"
projection["pet"].update(name="M" * 40, speech="M" * 160)
state.refresh(projection, [])
view.draw(state, client)
for title, detail in (("Could not open", "This badge could not open its account data. Press Home to exit."),
                      ("Account link unavailable", "Saved progress and pairing data are retained. Press Home to exit."),
                      ("Returning home", "Release Home to return to the launcher.")):
    view.message(title, detail, error=True)
client.pending_count, client.status = 0, "SYNCED"
projection["pet"].update(animal_id="penguin", name="Penguin", speech="Your account follows you between the web and your badge.")
projection["summary"].update(ended_focus_count=0, ended_break_count=0, hydration_count=5, movement_count=1, pet_count=0)
state.refresh(projection, [])
view.draw(state, client)
badgeware.display.update()
gc.collect()
print("DISPLAY_BOUNDS_AND_ACCOUNT_STATES_PASS", gc.mem_free())
print("FRAME", screen.width, screen.height, getattr(screen, "stride", screen.width * 4))
raw = memoryview(screen.raw)
for offset in range(0, len(raw), 1536):
    watchdog.feed()
    print(binascii.b2a_base64(raw[offset:offset + 1536]).decode().strip())
print("END_FRAME")
print("DATABASE_CLOSED_SAFE_TO_RESET")
