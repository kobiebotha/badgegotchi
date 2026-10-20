import badgeprobe
import gc

badge.mode(HIRES | VSYNC)
for frame in range(8):
    screen.pen = color.rgb(12, 24, 36)
    screen.clear()
    screen.pen = color.rgb(120, 240, 180)
    screen.text("Native module: 42", 20, 40)
    screen.rectangle(20 + frame * 12, 80, 10, 10)
    assert badgeprobe.answer(6) == 42
    assert badgeprobe.float_probe(1.25) == 1.75
    gc.collect()
    display.update()


def on_exit():
    assert badgeprobe.answer(6) == 42
    return "native-app-exit-ok"
