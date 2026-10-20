"""320 x 240 Badgeware view, adapted from the Pomogotchi art preview.

The capybara PNG is copied unchanged from Manrich121/pomogotchi, commit
10c33f5, flutter_pomogotchi/assets/animals/capybara.png. This module does
not assert a new license over that source artwork.
"""


class AppView:
    def __init__(self, screen, color, font, image, rect, asset_path):
        self.screen = screen
        self.screen.font = font.sins
        self.make_rect = rect
        self.pet = image.load(asset_path)
        self.pet_crop = rect(32, 110, 123, 90)
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

    def wrap(self, value, width=280):
        lines = []
        line = ""
        for word in value.split():
            candidate = word if not line else line + " " + word
            if self.screen.measure_text(candidate, 1)[0] > width and line:
                lines.append(line)
                line = word
            else:
                line = candidate
        if line:
            lines.append(line)
        return lines

    def header(self):
        self.screen.pen = self.cream
        self.screen.clear()
        self.text("BADGEGOTCHI", 12, 8, self.green)
        self.box(237, 6, 73, 17, self.sage)
        self.text("LOCAL ONLY", 273, 9, self.green, center=True)
        self.box(10, 28, 300, 1, self.line)

    def message(self, title, detail, error=False):
        self.header()
        self.text(title, 160, 75, self.ink, 2, center=True)
        for index, line in enumerate(self.wrap(detail)):
            self.text(line, 160, 112 + index * 16, self.muted, center=True)
        self.text("HOME: EXIT" if error else "Opening your saved companion...",
                  160, 215, self.green, center=True)

    @staticmethod
    def count(value):
        if value >= 1000000:
            return "1m"
        if value >= 1000:
            return str(value // 1000) + "k"
        return str(value)

    def draw(self, state):
        self.header()
        self.screen.pen = self.sage
        self.screen.circle(80, 85, 45)
        hop = 0
        if state.reaction_ms:
            age = 1800 - state.reaction_ms
            if age < 480:
                hop = (0, -2, -4, -4, -2, 0)[min(5, age // 80)]
        self.screen.blit(self.pet, self.pet_crop,
                         self.make_rect(18, 42 + hop, 123, 90))
        self.text(state.name, 80, 134, self.ink, center=True)
        if state.reaction_ms:
            age = 1800 - state.reaction_ms
            for x, y, delay in ((48, 65, 0), (108, 73, 180), (130, 56, 360)):
                heart_age = age - delay
                if 0 <= heart_age < 1100:
                    self.heart(x, y - heart_age // 50, 2)

        self.text("FOCUS" if state.phase == "focus" else "BREAK",
                  235, 42, self.green, center=True)
        seconds = (state.remaining_ms + 999) // 1000
        self.text("%02d:%02d" % (seconds // 60, seconds % 60),
                  235, 65, self.ink, 4, center=True)
        self.box(174, 107, 122, 3, self.line)
        duration = 2400000 if state.phase == "focus" else 600000
        progress = max(0, min(122, 122 * (duration - state.remaining_ms) // duration))
        if progress:
            self.box(174, 107, progress, 3, self.green)
        self.text("B: PAUSE" if state.running else "B: START",
                  235, 117, self.green, center=True)
        self.text("HOME: EXIT", 235, 134, self.muted, center=True)

        self.box(10, 151, 300, 1, self.line)
        labels = ((12, "Focus", state.focus_count), (88, "Water", state.water_count),
                  (168, "Stretch", state.stretch_count), (250, "Pets", state.pet_count))
        for x, label, value in labels:
            self.text(label, x, 157, self.muted)
            self.text(self.count(value), x, 171, self.green)
        self.text("Saved totals", 160, 187, self.muted, center=True)

        self.box(8, 201, 304, 16, self.paper)
        lines = self.wrap(state.speech, 296)
        # Every current acknowledgement is a single line at the badge font size.
        self.text(lines[0] if lines else "", 160, 203, self.ink, center=True)
        self.box(0, 221, 320, 19, self.green)
        self.text("A Pet   B Timer   C Water   UP Stretch", 160, 225,
                  self.paper, center=True)
