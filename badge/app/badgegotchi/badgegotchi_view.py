"""320 x 240 account view using the same animal artwork as the web app."""

ANIMALS = ("bear", "capybara", "cat", "chameleon", "cheeta", "cow", "dog", "duck", "fox", "hamster",
           "hedgehog", "hippo", "monkey", "octopus", "otter", "owl", "panda", "parrot", "peacock",
           "penguin", "pig", "rabbit", "racoon", "rhino", "rooster", "seal", "sheep", "sloth", "snake", "turtle")



class AppView:
    def __init__(self, screen, color, font, image, rect, asset_path):
        self.screen = screen
        self.screen.font = font.sins
        self.make_rect = rect
        self.images, self.asset_path = image, asset_path
        self.pet = self.animal_id = None
        self.pet_crop = rect(0, 0, 200, 200)
        self.cream = color.rgb(248, 242, 227)
        self.paper = color.rgb(255, 252, 244)
        self.ink = color.rgb(54, 45, 37)
        self.muted = color.rgb(113, 107, 88)
        self.line = color.rgb(218, 211, 190)
        self.green = color.rgb(61, 92, 65)
        self.sage = color.rgb(225, 233, 206)
        self.pink = color.rgb(218, 76, 111)

    def box(self, x, y, width, height, pen):
        self.screen.pen = pen
        self.screen.rectangle(x, y, width, height)

    def text(self, value, x, y, pen, scale=1, center=False):
        self.screen.pen = pen
        if center:
            width, _ = self.screen.measure_text(value, scale)
            x -= int(width) // 2
        self.screen.text(value, x, y, scale)

    def heart(self, x, y, scale=1):
        self.box(x + scale, y, 2 * scale, scale, self.pink)
        self.box(x + 4 * scale, y, 2 * scale, scale, self.pink)
        self.box(x, y + scale, 7 * scale, 2 * scale, self.pink)
        self.box(x + scale, y + 3 * scale, 5 * scale, scale, self.pink)
        self.box(x + 2 * scale, y + 4 * scale, 3 * scale, scale, self.pink)
        self.box(x + 3 * scale, y + 5 * scale, scale, scale, self.pink)

    def clip(self, value, width):
        if self.screen.measure_text(value, 1)[0] <= width:
            return value
        while value and self.screen.measure_text(value + "...", 1)[0] > width:
            value = value[:-1]
        return value + "..."

    def wrap(self, value, width=280):
        lines, line = [], ""
        for word in value.split():
            # A server message may contain one long URL/name without spaces.
            # Break it by measured glyph width instead of letting it overflow.
            pieces, piece = [], ""
            for char in word:
                if piece and self.screen.measure_text(piece + char, 1)[0] > width:
                    pieces.append(piece)
                    piece = char
                else:
                    piece += char
            if piece:
                pieces.append(piece)
            for piece in pieces:
                candidate = piece if not line else line + " " + piece
                if self.screen.measure_text(candidate, 1)[0] > width and line:
                    lines.append(line)
                    line = piece
                else:
                    line = candidate
        if line:
            lines.append(line)
        return lines

    def header(self, status="PAIR BADGE"):
        self.screen.pen = self.cream
        self.screen.clear()
        self.text("BADGEGOTCHI", 12, 8, self.green)
        self.box(237, 6, 73, 17, self.sage)
        self.text(status, 273, 9, self.green, center=True)
        self.box(10, 28, 300, 1, self.line)

    def message(self, title, detail, error=False):
        self.header()
        self.text(title, 160, 75, self.ink, 2, center=True)
        for index, line in enumerate(self.wrap(detail)):
            self.text(line, 160, 112 + index * 16, self.muted, center=True)
        self.text("HOME: EXIT" if error else "Opening your saved companion...",
                  160, 215, self.green, center=True)

    def pairing(self, client):
        self.header(client.status)
        pairing = client.pairing
        if client.sync is not None and client.sync.phase == "revoked":
            self.message("Link revoked", "This badge was revoked in the web app. Saved progress and queued work are retained.", error=True)
            return
        if pairing.state == "enter":
            self.text("Pair your badge", 160, 42, self.ink, 2, center=True)
            self.text("Open Pair badge in the web app.", 160, 77, self.muted, center=True)
            self.text("Enter its code with A, B and C.", 160, 95, self.muted, center=True)
            code = pairing.code + "_" * (12 - len(pairing.code))
            self.text(" ".join(code[:6]), 160, 126, self.green, 2, center=True)
            self.text(" ".join(code[6:]), 160, 154, self.green, 2, center=True)
            self.text("UP: erase    HOME: exit", 160, 213, self.green, center=True)
        elif pairing.state == "failed":
            self.text("Try a new code", 160, 57, self.ink, 2, center=True)
            for index, line in enumerate(self.wrap(pairing.error)):
                self.text(line, 160, 105 + index * 18, self.muted, center=True)
            self.text("B: restart    HOME: exit", 160, 213, self.green, center=True)
        else:
            self.text("Confirm in web app", 160, 48, self.ink, 2, center=True)
            self.text("Approve only the matching ID:", 160, 88, self.muted, center=True)
            self.text(pairing.verification_id or "Connecting...", 160, 118, self.green, 2, center=True)
            for index, line in enumerate(self.wrap(pairing.error or "Your code alone cannot approve this badge.")):
                self.text(line, 160, 155 + index * 16, self.muted, center=True)
            self.text("HOME: exit safely", 160, 213, self.green, center=True)

    @staticmethod
    def count(value):
        if value is None:
            return "--"
        if value >= 1000000:
            return "1m"
        if value >= 1000:
            return str(value // 1000) + "k"
        return str(value)

    def details(self, client):
        self.header(client.status)
        state = client.state
        self.text("Totals", 160, 42, self.ink, 2, center=True)
        for x, y, label, value in ((20, 105, "Focus", state.focus_count), (175, 105, "Break", state.break_count),
                                   (20, 126, "Water", state.water_count), (175, 126, "Move", state.stretch_count),
                                   (20, 147, "Pets", state.pet_count)):
            self.text(label + " " + self.count(value), x, y, self.ink)
        if client.pending_count:
            self.text(str(client.pending_count) + " pending", 160, 174, self.muted, center=True)
        self.box(0, 221, 320, 19, self.green)
        self.text("B Stop timer   DOWN Back   HOME Exit", 160, 225, self.paper, center=True)

    def _animal(self, pet):
        animal_id = pet.get("animal_id") if pet else None
        if animal_id is not None and animal_id not in ANIMALS:
            animal_id = "cat"
        if animal_id != self.animal_id:
            self.pet = self.images.load(self.asset_path + "/" + animal_id + ".png") if animal_id else None
            self.animal_id = animal_id

    def draw(self, state, client):
        if client.show_details:
            self.details(client)
            return
        self.header(client.status)
        self.screen.pen = self.sage
        self.screen.circle(80, 82, 45)
        self._animal(state.pet)
        hop = 0
        if state.reaction_ms:
            age = 1800 - state.reaction_ms
            if age < 480:
                hop = (0, -2, -4, -4, -2, 0)[min(5, age // 80)]
        if self.pet is not None:
            self.screen.blit(self.pet, self.pet_crop, self.make_rect(30, 32 + hop, 100, 100))
        self.text(self.clip(state.name, 132), 80, 134, self.ink, center=True)
        if state.reaction_ms:
            age = 1800 - state.reaction_ms
            for x, y, delay in ((48, 65, 0), (108, 73, 180), (130, 56, 360)):
                heart_age = age - delay
                if 0 <= heart_age < 1100:
                    self.heart(x, y - heart_age // 50, 2)
        self.text("FOCUS" if state.phase == "focus" else "BREAK", 235, 42, self.green, center=True)
        seconds = (state.remaining_ms + 999) // 1000 if state.remaining_ms is not None else None
        timer_text = "%02d:%02d" % (seconds // 60, seconds % 60) if seconds is not None and (not state.running or state.clock_valid) else "--:--"
        self.text(timer_text, 235, 65, self.ink, 4, center=True)
        self.box(174, 107, 122, 3, self.line)
        if state.timer and state.remaining_ms is not None:
            duration = state.timer["planned_duration_seconds"] * 1000
            progress = max(0, min(122, 122 * (duration - state.remaining_ms) // duration))
            if progress:
                self.box(174, 107, progress, 3, self.green)
        control = "B: PAUSE" if state.running else ("B: RESUME" if state.timer and state.timer.get("state") == "paused" else "B: START")
        self.text(control if state.timer else "Waiting for sync", 235, 117, self.green, center=True)
        self.text("DOWN: INFO / HOME: EXIT", 235, 134, self.muted, center=True)
        self.box(10, 151, 300, 1, self.line)
        labels = ((12, "Focus", state.focus_count), (88, "Break", state.break_count),
                  (168, "Water", state.water_count), (250, "Move", state.stretch_count))
        for x, label, value in labels:
            self.text(label, x, 157, self.muted)
            self.text(self.count(value), x, 171, self.green)
        if client.pending_count:
            self.text(str(client.pending_count) + " pending", 160, 187, self.muted, center=True)
        self.box(8, 201, 304, 16, self.paper)
        speech = state.speech
        if state.running and not state.clock_valid:
            speech = "Set badge clock to show your account timer."
        lines = self.wrap(speech, 296)
        self.text(lines[0] if lines else "", 160, 203, self.ink, center=True)
        self.box(0, 221, 320, 19, self.green)
        self.text("A Pet   B Timer   C Water   UP Move", 160, 225, self.paper, center=True)
