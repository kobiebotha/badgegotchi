"""Account-only timer, totals and foreground Home lifecycle."""
import copy
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app" / "badgegotchi"))
from badgegotchi_state import AppState, unix_seconds, remaining_seconds, optimistic_timer, transition_seconds

SESSION = "11111111-1111-4111-8111-111111111111"
NEXT = "22222222-2222-4222-8222-222222222222"
STAMP = "2026-10-20T22:00:00Z"
NOW = unix_seconds(STAMP)


def timer(**changes):
    result = dict(id=SESSION, type="focus", state="active", revision="9007199254740993",
                  planned_duration_seconds=2400, remaining_seconds_at_pause=2400,
                  started_at=STAMP, last_resumed_at=STAMP, paused_at=None)
    result.update(changes)
    return result


def command(kind, **changes):
    result = dict(id=NEXT, type=kind, session_id=SESSION,
                  expected_revision="9007199254740993", occurred_at="2026-10-20T22:40:00Z")
    result.update(changes)
    return result


class StateTests(unittest.TestCase):
    def test_no_local_totals_or_invented_identity_before_sync(self):
        state = AppState(clock=lambda: NOW)
        self.assertIsNone(state.timer)
        self.assertIsNone(state.water_count)
        self.assertIsNone(state.focus_count)
        self.assertIsNone(state.remaining_ms)
        self.assertEqual(state.pet, {})
        self.assertNotEqual(state.name, "Mochi")

    def test_utc_parser_and_paused_timer_are_timezone_independent(self):
        import datetime
        for stamp in ("2024-02-29T12:34:56Z", "2026-10-20T22:00:00.123456+00:00", "2099-12-31T23:59:59Z"):
            expected = int(datetime.datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp())
            self.assertEqual(unix_seconds(stamp), expected)
        for bad in ("2025-02-29T12:00:00Z", "2026-01-01T25:00:00Z", "2026-01-01T00:00:00-07:00"):
            with self.assertRaises(ValueError):
                unix_seconds(bad)
        self.assertEqual(remaining_seconds(timer(state="paused", remaining_seconds_at_pause=122), NOW + 5000), 122)

    def test_fractional_server_anchor_cannot_complete_early(self):
        fractional = timer(last_resumed_at="2026-10-20T22:00:00.900+00:00")
        self.assertEqual(remaining_seconds(fractional, NOW + 2400), 1)
        self.assertEqual(remaining_seconds(fractional, NOW + 2401), 0)

    def test_command_time_clamps_after_fractional_shared_transition(self):
        paused = timer(state="paused", paused_at="2026-10-20T22:00:00.900Z")
        self.assertEqual(transition_seconds(paused, NOW), NOW + 1)
        resumed = timer(last_resumed_at="2026-10-20T22:00:00.500+00:00")
        self.assertEqual(transition_seconds(resumed, NOW), NOW + 1)
        self.assertEqual(transition_seconds(resumed, NOW + 4), NOW + 4)
        self.assertIsNone(transition_seconds(resumed, None))

    def test_home_reopen_uses_same_synced_clock_anchor(self):
        projection = {"timer": timer()}
        first = AppState(clock=lambda: NOW + 20)
        first.refresh(projection, [])
        self.assertEqual(first.remaining_ms, 2380000)
        reopened = AppState(clock=lambda: NOW + 110)
        reopened.refresh(projection, [])
        self.assertEqual(reopened.remaining_ms, 2290000)
        self.assertTrue(reopened.running)
        self.assertEqual(projection["timer"]["last_resumed_at"], STAMP)

    def test_pending_completion_creates_opposite_paused_phase_with_exact_revision(self):
        result = optimistic_timer(timer(), command("timer_complete"))
        self.assertEqual((result["id"], result["type"], result["state"], result["revision"]),
                         (NEXT, "break", "paused", "9007199254740994"))
        self.assertEqual(remaining_seconds(result, NOW + 99999), 600)
        stopped = optimistic_timer(timer(), command("timer_stop"))
        self.assertEqual((stopped["type"], stopped["state"], stopped["remaining_seconds_at_pause"]), ("focus", "paused", 2400))

    def test_queued_actions_overlay_timer_but_never_inflate_confirmed_totals(self):
        state = AppState(clock=lambda: NOW + 2400)
        projection = {"timer": timer(), "summary": {"day_key": "2026-10-20", "hydration_count": 3,
                      "movement_count": 2, "ended_focus_count": 4, "pet_count": 7}}
        state.refresh(projection, [command("timer_complete"), {"type": "hydration"}])
        self.assertEqual((state.focus_count, state.water_count, state.stretch_count, state.pet_count), (4, 3, 2, 7))
        self.assertEqual((state.phase, state.running), ("break", False))
        newer = timer(revision="9007199254740995", state="paused", remaining_seconds_at_pause=500)
        self.assertEqual(optimistic_timer(newer, command("timer_complete")), newer)

    def test_held_buttons_chords_and_completion_do_not_repeat(self):
        state = AppState(clock=lambda: NOW)
        self.assertEqual(state.step(["pet"], 0), [])
        self.assertEqual(state.step([], 0), [])
        self.assertEqual(state.step(["pet", "water"], 0), [])
        state.step([], 0)
        self.assertEqual(state.step(["water"], 0), ["water"])
        self.assertEqual(state.step(["water"], 100), [])
        state.refresh({"timer": timer(last_resumed_at="2026-10-20T21:00:00Z")}, [])
        self.assertEqual(state.step([], 0), ["complete"])
        state.refresh({"timer": timer()}, [command("timer_complete")])
        self.assertEqual(state.step([], 0), [])

    def test_unset_clock_never_completes_account_timer(self):
        state = AppState(clock=lambda: None)
        state.refresh({"timer": timer()}, [])
        state.step([], 0)
        self.assertFalse(state.clock_valid)
        self.assertEqual(state.step([], 9999999), [])


class EntryLifecycleTests(unittest.TestCase):
    def exercise(self, home=False, paired=True, fail=False):
        events, messages, busy = [], [], [False]
        class Pin:
            IRQ_FALLING = 1
            def irq(self, trigger, handler): self.handler = handler
            def value(self): return True
        pin = Pin(); Pin.board = types.SimpleNamespace(BUTTON_HOME=pin)
        class Store:
            def __init__(self, **kwargs): pass
            def open(self): events.append("open")
            def save(self, *args): raise AssertionError("No local-only state may be saved")
            def close(self):
                assert not busy[0]
                events.append("close")
        class Client:
            def __init__(self, *args, **kwargs): self.state = object(); self.ready = paired
            def step(self, *args):
                busy[0] = True
                try:
                    if home:
                        pin.handler(pin); events.append("home requested")
                    if fail: raise OSError("network")
                finally: busy[0] = False
            def close(self):
                assert not busy[0]
                events.append("client closed")
        class View:
            def __init__(self, *args): pass
            def message(self, *args, **kwargs): messages.append(args)
            def draw(self, *args): events.append("account view")
            def pairing(self, *args): events.append("pairing view")
        class WDT:
            def __init__(self, **kwargs): pass
            def feed(self): pass
        modules = {"badgeware": types.SimpleNamespace(display=types.SimpleNamespace(update=lambda: None), reset=lambda: events.append("reset")),
                   "machine": types.SimpleNamespace(WDT=WDT, Pin=Pin),
                   "time": types.SimpleNamespace(ticks_ms=lambda: 1, ticks_diff=lambda a,b: a-b, sleep_ms=lambda n: None),
                   "badgegotchi_storage": types.SimpleNamespace(Store=Store), "badgegotchi_view": types.SimpleNamespace(AppView=View),
                   "badgegotchi_client": types.SimpleNamespace(Client=Client)}
        env = dict(badge=types.SimpleNamespace(mode=lambda n: None, held=lambda n: False), HIRES=1, VSYNC=2,
                   screen=None,color=None,font=None,image=None,rect=None,BUTTON_A=1,BUTTON_B=2,BUTTON_C=3,BUTTON_UP=4,BUTTON_DOWN=5,
                   run=lambda update: update())
        path = Path(__file__).resolve().parents[1]/"app"/"badgegotchi"/"__init__.py"
        with patch.dict(sys.modules, modules): exec(compile(path.read_text(),str(path),"exec"),env)
        return events, messages, pin

    def test_home_defers_cleanup_until_foreground_and_never_saves_local_progress(self):
        events, _, _ = self.exercise(home=True)
        self.assertEqual(events, ["open", "home requested", "client closed", "close", "reset"])

    def test_unpaired_launch_only_shows_pairing(self):
        events, _, _ = self.exercise(paired=False)
        self.assertIn("pairing view", events)
        self.assertNotIn("account view", events)

    def test_normal_exit_and_failure_close_account_resources(self):
        for fail in (False, True):
            events, _, pin = self.exercise(fail=fail)
            self.assertEqual(events[-2:], ["client closed", "close"])
            self.assertEqual(pin.handler.__name__, "closed_home")


if __name__ == "__main__": unittest.main()
