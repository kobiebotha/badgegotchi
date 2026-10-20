"""Timer behavior without a badge, filesystem, or clock."""

import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app" / "badgegotchi"))
from badgegotchi_state import AppState, FOCUS_MS, BREAK_MS, rtc_seconds


class StateTests(unittest.TestCase):
    def setUp(self):
        self.now = 1792526000

    def ready(self, snapshot=None):
        state = AppState(snapshot, clock=lambda: self.now)
        state.step((), 0)
        return state

    def press(self, state, button):
        state.step((), 0)
        return state.step((button,), 0)

    def test_start_pause_resume_credits_only_running_time(self):
        state = self.ready()
        self.assertTrue(self.press(state, "toggle"))
        state.step((), 1234)
        self.assertEqual(state.remaining_ms, FOCUS_MS - 1234)
        self.press(state, "toggle")
        state.step((), 50000)
        self.assertEqual(state.remaining_ms, FOCUS_MS - 1234)
        self.press(state, "toggle")
        state.step((), 766)
        self.assertEqual(state.remaining_ms, FOCUS_MS - 2000)

    def test_focus_completion_saves_once_and_waits_for_break_start(self):
        state = self.ready()
        state.remaining_ms = 1000
        self.press(state, "toggle")
        self.assertTrue(state.step((), 1001))
        self.assertEqual((state.phase, state.remaining_ms, state.focus_count),
                         ("break", BREAK_MS, 1))
        self.assertFalse(state.running)
        self.assertFalse(state.step((), 60000))
        self.assertEqual(state.focus_count, 1)
        self.assertEqual(state.remaining_ms, BREAK_MS)
        self.press(state, "toggle")
        state.remaining_ms = 1000
        state.step((), 1000)
        self.assertEqual((state.phase, state.remaining_ms, state.focus_count),
                         ("focus", FOCUS_MS, 1))
        self.assertFalse(state.running)

    def test_launch_button_hold_is_drained_and_holds_do_not_repeat(self):
        state = AppState()
        state.step(("pet", "toggle", "water", "stretch"), 0)
        state.step(("pet",), 1000)
        self.assertEqual(state.pet_count, 0)
        self.assertFalse(state.running)
        state.step((), 0)
        self.assertTrue(state.step(("pet", "water", "stretch"), 0))
        self.assertFalse(state.step(("pet", "water", "stretch"), 1000))
        self.assertEqual((state.pet_count, state.water_count, state.stretch_count), (1, 1, 1))
        self.press(state, "pet")
        self.assertEqual(state.pet_count, 2)

    def test_checkpoint_is_due_each_minute_not_each_frame(self):
        state = self.ready()
        self.press(state, "toggle")
        state.saved()
        self.assertFalse(state.step((), 59000))
        self.assertTrue(state.step((), 1000))
        state.saved()
        self.assertFalse(state.step((), 1000))
        self.assertTrue(state.step((), 59000))

    def test_reentry_counts_time_away_and_keeps_running(self):
        state = self.ready()
        for button in ("pet", "water", "stretch", "toggle"):
            self.press(state, button)
        state.step((), 1000)
        snapshot = state.snapshot()
        self.now += 45
        restored = self.ready(snapshot)
        self.assertTrue(restored.running)
        self.assertEqual(restored.remaining_ms, FOCUS_MS - 46000)
        self.assertEqual((restored.pet_count, restored.water_count, restored.stretch_count), (1, 1, 1))
        self.assertTrue(snapshot["running"])

    def test_away_completion_is_counted_once_and_does_not_chain(self):
        state = self.ready()
        state.remaining_ms = 1000
        self.press(state, "toggle")
        snapshot = state.snapshot()
        self.now += 3600
        restored = self.ready(snapshot)
        self.assertEqual((restored.phase, restored.focus_count, restored.running),
                         ("break", 1, False))
        self.assertEqual(restored.remaining_ms, BREAK_MS)
        again = self.ready(restored.snapshot())
        self.assertEqual((again.phase, again.focus_count), ("break", 1))

    def test_paused_timer_ignores_elapsed_time_away(self):
        state = self.ready()
        self.press(state, "toggle")
        state.step((), 1234)
        self.press(state, "toggle")
        snapshot = state.snapshot()
        self.now += 3600
        restored = self.ready(snapshot)
        self.assertFalse(restored.running)
        self.assertEqual(restored.remaining_ms, FOCUS_MS - 1234)

    def test_clock_reset_or_backwards_pauses_without_credit(self):
        state = self.ready()
        self.press(state, "toggle")
        snapshot = state.snapshot()
        for now in (None, self.now - 1):
            restored = AppState(snapshot, clock=lambda: now)
            self.assertFalse(restored.running)
            self.assertEqual(restored.remaining_ms, FOCUS_MS)
            self.assertEqual(restored.focus_count, 0)
            self.assertIsNotNone(restored.clock_notice)
            self.assertTrue(restored.step((), 0))

    def test_legacy_timer_has_no_anchor_and_remains_paused(self):
        snapshot = self.ready().snapshot()
        snapshot.pop("clock_saved_s")
        snapshot["running"] = True
        restored = self.ready(snapshot)
        self.assertFalse(restored.running)
        self.assertEqual(restored.remaining_ms, FOCUS_MS)

    def test_rtc_converts_micropython_2000_epoch_and_rejects_unset(self):
        fake_time = types.SimpleNamespace(time=lambda: 100,
                                         gmtime=lambda n: (2000 if n == 0 else 2026,))
        with patch("badgegotchi_state.time", fake_time):
            self.assertEqual(rtc_seconds(), 946684900)
        fake_time.gmtime = lambda n: (2000,)
        with patch("badgegotchi_state.time", fake_time):
            self.assertIsNone(rtc_seconds())

    def test_negative_and_untrusted_large_elapsed_are_bounded(self):
        state = self.ready()
        self.press(state, "toggle")
        state.step((), -2000)
        self.assertEqual(state.remaining_ms, FOCUS_MS)
        state.step((), 999999999)
        self.assertEqual(state.remaining_ms, FOCUS_MS - 60000)
        self.assertEqual(state.focus_count, 0)

    def test_invalid_saved_state_is_rejected_not_replaced(self):
        state = AppState().snapshot()
        for key, bad in (("phase", "invalid"), ("remaining_ms", -1),
                         ("pet_count", True), ("water_count", 1000001)):
            changed = dict(state)
            changed[key] = bad
            with self.assertRaises(ValueError):
                AppState(changed)
        changed = dict(state)
        changed["phase"] = "break"
        with self.assertRaises(ValueError):
            AppState(changed)

    def test_counter_cap_and_expiring_pet_animation(self):
        state = self.ready()
        state.pet_count = 1000000
        self.press(state, "pet")
        self.assertEqual(state.pet_count, 1000000)
        self.assertEqual(state.reaction_ms, 1800)
        state.step((), 1800)
        self.assertEqual(state.reaction_ms, 0)
        self.assertNotEqual(state.speech, "A little focus. A little company.")
        state.step((), 3200)
        self.assertEqual(state.speech, "A little focus. A little company.")


class EntryLifecycleTests(unittest.TestCase):
    def exercise(self, fault=None, home_during_save=False):
        saved, events, messages = [], [], []
        held, clock, busy = [set()], [0], [False]

        class Pin:
            IRQ_FALLING = 1

            def __init__(self):
                self.handler = None
                self.release_checks = 0

            def irq(self, trigger, handler):
                self.handler = handler

            def value(self):
                self.release_checks += 1
                return self.release_checks > 1

        pin = Pin()
        Pin.board = types.SimpleNamespace(BUTTON_HOME=pin)

        class Store:
            def __init__(self, heartbeat=None):
                self.heartbeat = heartbeat

            def open(self):
                assert pin.handler.__name__ == "request_exit"
                if fault == "open":
                    raise ValueError("invalid owner")

            def load(self):
                return AppState().snapshot()

            def save(self, snapshot):
                assert not busy[0], "Home re-entered SQLite"
                busy[0] = True
                saved.append(dict(snapshot))
                events.append("save")
                try:
                    if home_during_save and len(saved) == 1:
                        pin.handler(pin)
                        events.append("home flagged during save")
                        assert busy[0]
                    if fault == "save":
                        raise OSError("save failed")
                finally:
                    busy[0] = False

            def close(self):
                assert not busy[0], "Home closed during SQLite execution"
                events.append("close")

        class View:
            def __init__(self, *args):
                pass

            def message(self, *args, **kwargs):
                messages.append(args)

            def draw(self, state):
                pass

        class WDT:
            def __init__(self, timeout):
                assert timeout == 16000

            def feed(self):
                pass

        def run(update):
            for keys in (set(), {2}, set()):
                clock[0] += 1000
                held[0] = keys
                if update() is not None:
                    break

        modules = {
            "badgeware": types.SimpleNamespace(
                display=types.SimpleNamespace(update=lambda: None),
                reset=lambda: events.append("reset")),
            "machine": types.SimpleNamespace(WDT=WDT, Pin=Pin),
            "time": types.SimpleNamespace(ticks_ms=lambda: clock[0],
                                          ticks_diff=lambda a, b: a - b,
                                          sleep_ms=lambda n: events.append("wait release")),
            "badgegotchi_storage": types.SimpleNamespace(Store=Store),
            "badgegotchi_view": types.SimpleNamespace(AppView=View),
        }
        env = dict(badge=types.SimpleNamespace(mode=lambda n: None,
                                              held=lambda n: n in held[0]),
                   HIRES=1, VSYNC=2, screen=None, color=None, font=None,
                   image=None, rect=None, BUTTON_A=1, BUTTON_B=2,
                   BUTTON_C=3, BUTTON_UP=4, run=run)
        path = Path(__file__).resolve().parents[1] / "app" / "badgegotchi" / "__init__.py"
        with patch.dict(sys.modules, modules):
            exec(compile(path.read_text(), str(path), "exec"), env)
        return saved, events, messages, pin

    def test_normal_exit_keeps_running_saves_closes_without_forcing_reset(self):
        saved, events, _, pin = self.exercise()
        self.assertTrue(saved[0]["running"])
        self.assertTrue(saved[-1]["running"])
        self.assertEqual(saved[-1]["remaining_ms"], FOCUS_MS - 1000)
        self.assertEqual(events[-1], "close")
        self.assertNotIn("reset", events)
        self.assertEqual(pin.handler.__name__, "closed_home")

    def test_home_during_save_defers_sql_cleanup_and_reset_until_release(self):
        saved, events, _, _ = self.exercise(home_during_save=True)
        self.assertEqual(events, ["save", "home flagged during save", "save",
                                  "close", "wait release", "reset"])
        self.assertTrue(saved[-1]["running"])

    def test_storage_errors_close_without_retrying_a_failed_save(self):
        for fault in ("open", "save"):
            saved, events, messages, _ = self.exercise(fault=fault)
            self.assertEqual(len(saved), 0 if fault == "open" else 1)
            self.assertEqual(events[-1], "close")
            self.assertEqual(messages[-1][0], "Could not open" if fault == "open"
                             else "Save unavailable")


if __name__ == "__main__":
    unittest.main()
