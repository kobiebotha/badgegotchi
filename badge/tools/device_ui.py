"""Bounded installed-app launch and real-display bounds/capture qualification."""
import binascii
import builtins
import gc
import machine
import os
import sys
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


def bounded_run(update):
    app = sys.modules[APP]
    assert app.storage_ok and app.failure is None, "App failed to open installed storage"
    assert app.store.version == "0.5.4/cratesio"

    def frame():
        watchdog.feed()
        frames[0] += 1
        return update()

    badgeware._run(frame, duration=250)


try:
    builtins.run = bounded_run
    badgeware.fatal_error = raise_error
    badgegotchi_view.AppView = checked_view
    badgeware.launch(APP)
    assert frames[0] >= 2
    print("INSTALLED_APP_LAUNCH_PASS", frames[0])
finally:
    builtins.run = original_run
    badgegotchi_view.AppView = original_view
    badgeware.fatal_error = original_fatal

# Independently exercise visual states; do not save simulated actions.
os.chdir(APP)
state = AppState()
state.step([], 0)
view = original_view(CheckedScreen(), color, font, image, rect, "assets/capybara.png")
for action in ("pet", "toggle", "water", "stretch"):
    state.step([action], 16)
    for _ in range(12):
        watchdog.feed()
        state.step([action], 80)
        view.draw(state)
    state.step([], 16)
for value in (0, 999, 1000, 999999, 1000000):
    for name in ("focus_count", "water_count", "stretch_count", "pet_count"):
        setattr(state, name, value)
    view.draw(state)
for title, detail in (("Could not open", "This badge could not open its saved data. Nothing was reset."),
                      ("Save unavailable", "Saving stopped. Existing data was not reset. Press Home to exit."),
                      ("Returning home", "Release Home to return to the launcher.")):
    view.message(title, detail, error=True)
state = AppState()
state.step([], 0)
state.step(["pet"], 16)
state.step([], 420)
view.draw(state)
badgeware.display.update()
gc.collect()
print("DISPLAY_BOUNDS_AND_STATES_PASS", gc.mem_free())
print("FRAME", screen.width, screen.height, getattr(screen, "stride", screen.width * 4))
raw = memoryview(screen.raw)
for offset in range(0, len(raw), 1536):
    watchdog.feed()
    print(binascii.b2a_base64(raw[offset:offset + 1536]).decode().strip())
print("END_FRAME")
print("DATABASE_CLOSED_SAFE_TO_RESET")
