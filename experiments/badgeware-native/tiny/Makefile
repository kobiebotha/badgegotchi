MPY_DIR ?= ../vendor/micropython-41d1e007537f9b15cf13a9436228dd59d6485eca
MOD = badgeprobe
SRC = badgeprobe.c
ARCH = armv7emsp
BUILD = build
CFLAGS_EXTRA += -DMICROPY_OBJ_REPR=MICROPY_OBJ_REPR_C -mfloat-abi=softfp
include $(MPY_DIR)/py/dynruntime.mk
