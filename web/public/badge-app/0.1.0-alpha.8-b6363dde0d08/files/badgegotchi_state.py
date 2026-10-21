"""Account projection and pending-command view; no badge-only progress or timer."""
import time

FOCUS_MS = 40 * 60 * 1000
BREAK_MS = 10 * 60 * 1000
BUTTONS = ("pet", "toggle", "water", "stretch", "stop")


def rtc_seconds():
    try:
        value = int(time.time())
        if not 2024 <= time.gmtime(value)[0] < 2100:
            return None
        epoch = time.gmtime(0)[0]
        return value + (946684800 if epoch == 2000 else 0) if epoch in (1970, 2000) else None
    except (ValueError, OSError, OverflowError):
        return None


def unix_seconds(value, round_up=False):
    """Parse server UTC timestamps without relying on host timezone or epoch."""
    if not isinstance(value, str) or len(value) < 20:
        raise ValueError("Invalid account timestamp")
    if value[4:5] != "-" or value[7:8] != "-" or value[10:11] not in ("T", " ") or value[13:14] != ":" or value[16:17] != ":":
        raise ValueError("Invalid account timestamp")
    suffix = value[19:]
    fractional = False
    if suffix.startswith("."):
        end = 1
        while end < len(suffix) and suffix[end].isdigit():
            end += 1
        if end == 1:
            raise ValueError("Invalid account timestamp")
        fractional = any(c != "0" for c in suffix[1:end])
        suffix = suffix[end:]
    if suffix not in ("Z", "+00:00"):
        raise ValueError("Account timestamp must be UTC")
    year, month, day = int(value[:4]), int(value[5:7]), int(value[8:10])
    hour, minute, second = int(value[11:13]), int(value[14:16]), int(value[17:19])
    if not 2024 <= year < 2100 or not 1 <= month <= 12 or not 0 <= hour < 24 or not 0 <= minute < 60 or not 0 <= second < 60:
        raise ValueError("Invalid account timestamp")
    leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
    days = (31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
    if not 1 <= day <= days[month - 1]:
        raise ValueError("Invalid account date")
    count = (year - 1970) * 365 + (year - 1) // 4 - 1969 // 4 - (year - 1) // 100 + 1969 // 100 + (year - 1) // 400 - 1969 // 400
    count += sum(days[:month - 1]) + day - 1
    return count * 86400 + hour * 3600 + minute * 60 + second + (1 if round_up and fractional else 0)


def remaining_seconds(timer, now):
    base = timer.get("remaining_seconds_at_pause")
    if base is None:
        base = timer.get("planned_duration_seconds", 0)
    if type(base) is not int or not 0 <= base <= 2400:
        raise ValueError("Invalid account timer duration")
    if timer.get("state") == "ended":
        return 0
    if timer.get("state") != "active" or now is None:
        return base
    resumed = unix_seconds(timer["last_resumed_at"], round_up=True)
    return max(0, base - max(0, now - resumed))


def transition_seconds(timer, now):
    """Keep coarse badge timestamps after the exact synced web transition.

    A web transition can carry milliseconds within the badge's current whole
    second. Rounding its anchor up avoids sending a causally earlier action;
    the gateway clamps permitted future skew to its current server time.
    """
    if type(now) is not int or timer is None:
        return now
    for key in ("last_resumed_at", "paused_at", "started_at"):
        if timer.get(key) is not None:
            now = max(now, unix_seconds(timer[key], round_up=True))
    return now


def optimistic_timer(timer, command):
    kind = command["type"]
    if not kind.startswith("timer_") or timer is None:
        return timer
    if command["expected_revision"] != timer.get("revision"):
        return timer
    if kind != "timer_start" and command["session_id"] != timer.get("id"):
        return timer
    result = dict(timer)
    when = command["occurred_at"]
    if kind == "timer_start":
        phase = command["session_type"]
        result = {"id": command["new_session_id"], "type": phase, "state": "active",
                  "planned_duration_seconds": 2400 if phase == "focus" else 600,
                  "started_at": when, "last_resumed_at": when, "paused_at": None,
                  "remaining_seconds_at_pause": None}
    elif kind == "timer_pause":
        result.update(state="paused", paused_at=when,
                      remaining_seconds_at_pause=remaining_seconds(timer, unix_seconds(when)))
    elif kind == "timer_resume":
        result.update(state="active", last_resumed_at=when, paused_at=None)
    elif kind in ("timer_complete", "timer_stop"):
        phase = ("break" if timer.get("type") == "focus" else "focus") if kind == "timer_complete" else timer.get("type", "focus")
        duration = 2400 if phase == "focus" else 600
        result = {"id": command["id"], "type": phase, "state": "paused",
                  "planned_duration_seconds": duration, "started_at": when,
                  "last_resumed_at": when, "paused_at": when, "remaining_seconds_at_pause": duration}
    result["revision"] = str(int(command["expected_revision"]) + 1)
    return result


class AppState:
    def __init__(self, clock=rtc_seconds):
        self._clock = clock
        self.projection = {}
        self.timer = None
        self.pet = {}
        self.summary = {}
        self.phase = "focus"
        self.remaining_ms = None
        self.running = False
        self.clock_valid = False
        self.name = "Waiting for pet"
        self.reaction_ms = self.speech_ms = 0
        self.speech = "Waiting for account sync."
        self._held = set()
        self._wait_for_release = True
        self.refresh({}, [])

    def refresh(self, projection, commands):
        self.projection = projection
        self.pet = projection.get("pet", {})
        self.summary = projection.get("summary", {})
        self.name = self.pet.get("name") or "Waiting for pet"
        timer = projection.get("timer")
        if timer is not None:
            timer = dict(timer)
            from badgegotchi_commands import revision
            if not revision(timer.get("revision")):
                # Old cached projection is display-only until the shared schema arrives.
                timer = None
        for command in commands:
            timer = optimistic_timer(timer, command)
        self.timer = timer
        now = self._clock()
        self.clock_valid = type(now) is int
        self.phase = timer.get("type", "focus") if timer else "focus"
        self.running = bool(timer and timer.get("state") == "active")
        self.remaining_ms = remaining_seconds(timer, now) * 1000 if timer else None
        self.focus_count = self.summary.get("ended_focus_count", self.summary.get("completed_focus_count", 0) + self.summary.get("stopped_focus_count", 0)) if self.summary else None
        self.break_count = self.summary.get("ended_break_count", self.summary.get("completed_break_count", 0) + self.summary.get("stopped_break_count", 0)) if self.summary else None
        self.water_count = self.summary.get("hydration_count")
        self.stretch_count = self.summary.get("movement_count")
        self.pet_count = self.summary.get("pet_count")
        if not self.speech_ms:
            self.speech = self.pet.get("speech") or "Waiting for account sync."

    def _say(self, text):
        self.speech, self.speech_ms = text, 5000

    def step(self, held, elapsed_ms):
        self.reaction_ms = max(0, self.reaction_ms - max(0, elapsed_ms))
        self.speech_ms = max(0, self.speech_ms - max(0, elapsed_ms))
        held = set(name for name in held if name in BUTTONS)
        if self._wait_for_release:
            self._wait_for_release = bool(held)
            self._held = held
            return []
        pressed = held - self._held
        self._held = held
        if self.running and self.clock_valid and self.remaining_ms == 0:
            return ["complete"]
        return list(pressed) if len(pressed) == 1 and len(held) == 1 else []
