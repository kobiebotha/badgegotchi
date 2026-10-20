"""Offline timer and button state, independent of Badgeware and storage."""

import time

FOCUS_MS = 40 * 60 * 1000
BREAK_MS = 10 * 60 * 1000
CHECKPOINT_MS = 60 * 1000
MAX_STEP_MS = 60 * 1000
COUNTERS = ("focus_count", "water_count", "stretch_count", "pet_count")
BUTTONS = ("pet", "toggle", "water", "stretch")


def rtc_seconds():
    """Return normalized Unix seconds only when the badge clock is set."""
    try:
        value = int(time.time())
        year = time.gmtime(value)[0]
        if not 2024 <= year < 2100:
            return None
        epoch = time.gmtime(0)[0]
        if epoch == 2000:
            value += 946684800
        elif epoch != 1970:
            return None
        return value
    except (ValueError, OSError, OverflowError):
        return None


class AppState:
    def __init__(self, snapshot=None, clock=rtc_seconds):
        self._clock = clock
        if snapshot is None:
            snapshot = {"phase": "focus", "remaining_ms": FOCUS_MS,
                        "running": False, "focus_count": 0, "water_count": 0,
                        "stretch_count": 0, "pet_count": 0}
        if snapshot.get("phase") not in ("focus", "break"):
            raise ValueError("Invalid saved timer phase")
        self.phase = snapshot["phase"]
        maximum = FOCUS_MS if self.phase == "focus" else BREAK_MS
        remaining = snapshot.get("remaining_ms")
        if type(remaining) is not int or not 0 <= remaining <= maximum:
            raise ValueError("Invalid saved timer duration")
        self.remaining_ms = remaining
        self.running = False
        for name in COUNTERS:
            value = snapshot.get(name)
            if type(value) is not int or not 0 <= value <= 1000000:
                raise ValueError("Invalid saved counter")
            setattr(self, name, value)
        self.name = "Mochi"
        self.reaction_ms = 0
        self.speech = "A little focus. A little company."
        self.speech_ms = 0
        self._held = set()
        self._wait_for_release = True
        self._checkpoint_ms = 0
        self._restore_dirty = False
        self.clock_notice = None
        if snapshot.get("running"):
            saved_at = snapshot.get("clock_saved_s")
            now = self._clock()
            self._restore_dirty = True
            if (type(saved_at) is not int or type(now) is not int
                    or now < saved_at):
                self.clock_notice = "Clock unavailable or changed. Timer paused."
                self._say(self.clock_notice)
            else:
                self.running = True
                self.remaining_ms = max(0, self.remaining_ms - (now - saved_at) * 1000)
                if self.remaining_ms == 0:
                    self._complete()

    def snapshot(self):
        result = {"phase": self.phase, "remaining_ms": self.remaining_ms,
                  "running": self.running,
                  "clock_saved_s": self._clock() if self.running else None}
        for name in COUNTERS:
            result[name] = getattr(self, name)
        return result

    def pause(self):
        self.running = False

    def saved(self):
        self._checkpoint_ms = 0

    def _say(self, text):
        self.speech = text
        self.speech_ms = 5000

    def _increment(self, name):
        setattr(self, name, min(1000000, getattr(self, name) + 1))

    def _complete(self):
        self.running = False
        if self.phase == "focus":
            self._increment("focus_count")
            self.phase = "break"
            self.remaining_ms = BREAK_MS
            self._say("Focus complete! B starts your break.")
        else:
            self.phase = "focus"
            self.remaining_ms = FOCUS_MS
            self._say("Break complete. Ready when you are.")

    def step(self, held, elapsed_ms):
        """Advance elapsed time and return whether a durable save is due.

        A single delayed frame can credit at most one minute. The foreground
        app feeds a 16-second watchdog; a larger gap is not trusted elapsed
        focus time. Phase transitions always stop, so no unattended chaining.
        """
        elapsed_ms = min(MAX_STEP_MS, max(0, elapsed_ms))
        self.reaction_ms = max(0, self.reaction_ms - elapsed_ms)
        self.speech_ms = max(0, self.speech_ms - elapsed_ms)
        if self.speech_ms == 0:
            self.speech = self.clock_notice or "A little focus. A little company."
        changed = self._restore_dirty
        self._restore_dirty = False
        if self.running:
            self.remaining_ms = max(0, self.remaining_ms - elapsed_ms)
            self._checkpoint_ms += elapsed_ms
            if self.remaining_ms == 0:
                self._complete()
                changed = True

        held = set(name for name in held if name in BUTTONS)
        if self._wait_for_release:
            self._wait_for_release = bool(held)
            self._held = held
            return changed
        pressed = held - self._held
        self._held = held
        if "pet" in pressed:
            self._increment("pet_count")
            self.reaction_ms = 1800
            self._say("Pet saved. A little moment together.")
            changed = True
        if "toggle" in pressed:
            self.running = not self.running
            self.clock_notice = ("Set badge clock to count while away."
                                 if self.running and self._clock() is None else None)
            self._say(("Focus" if self.phase == "focus" else "Break") +
                      (" started. One step at a time." if self.running
                       else " paused. B when you are ready."))
            changed = True
        if "water" in pressed:
            self._increment("water_count")
            self._say("Water saved. A small sip helps.")
            changed = True
        if "stretch" in pressed:
            self._increment("stretch_count")
            self._say("Stretch saved. Uncurl those shoulders.")
            changed = True
        return changed or (self.running and self._checkpoint_ms >= CHECKPOINT_MS)
