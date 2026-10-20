"""Execute from host mount; creates no device files."""
import sys
import gc
import time

if "/remote" not in sys.path:
    sys.path.insert(0, "/remote")
gc.collect()
before = gc.mem_free()
import badgeprobe
print("NATIVE_IMPORTED")
assert badgeprobe.answer(6) == 42
assert badgeprobe.float_probe(1.25) == 1.75
block = bytearray(4096)
print("LOCATIONS_TEXT_CONST_BSS_STACK_BUFFER_CALLS",
      tuple(hex(x) for x in badgeprobe.locations(block)))
for cycle in range(8):
    for i in range(128):
        assert badgeprobe.answer(i) == i * 7
    gc.collect()
    assert badgeprobe.float_probe(1.25) == 1.75
print("CALLS_AFTER_GC", badgeprobe.locations(block)[5])
print("IMPORT_AND_CALLS_BYTES", before - gc.mem_free())

# Bounded heap exercise, maximum 256 KiB extra allocation.
gc.collect()
allocation_before = gc.mem_free()
for size in (16384, 65536, 262144):
    allocation = bytearray(size)
    allocation[0] = 0x5A
    allocation[-1] = 0xA5
    gc.collect()
    assert allocation[0] == 0x5A and allocation[-1] == 0xA5
    assert badgeprobe.answer(6) == 42
    print("BOUNDED_ALLOCATION", size, hex(badgeprobe.locations(allocation)[4]), gc.mem_free())
    del allocation
    gc.collect()
print("ALLOCATION_RECOVERY", allocation_before, gc.mem_free())
print("TINY_SMOKE_PASS")
