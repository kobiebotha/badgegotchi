MOD = badge_sqlite
ifeq ($(WITH_POWERSYNC),1)
MOD = badge_powersync
BUILD = build-core
CFLAGS_EXTRA += -DBADGE_POWERSYNC
MPY_LD_FLAGS += -l../powersync-audit/build/thumbv8m.main-none-eabi/release/libpowersync.a
endif
MPY_DIR ?= ../vendor/micropython-41d1e007537f9b15cf13a9436228dd59d6485eca
ARCH = armv7emsp
SRC = module.c sqlite_port.c libc_shim.c vfs.c
LINK_RUNTIME = 1
CFLAGS_EXTRA += -DMICROPY_OBJ_REPR=MICROPY_OBJ_REPR_C -Wno-misleading-indentation -Wno-unused-value -Wno-unused-function -Wno-unused-variable -Wno-unused-but-set-variable -Wno-sign-compare -fno-builtin -fdata-sections -mfloat-abi=softfp
include $(MPY_DIR)/py/dynruntime.mk
# Resolve multilib explicitly: the upstream helper's early := evaluation
# otherwise selected the default ARM-state libraries on this host.
LIBGCC_PATH = $(shell $(CC) -mthumb -mcpu=cortex-m4 -mfpu=fpv4-sp-d16 -mfloat-abi=softfp --print-libgcc-file-name)
LIBM_PATH = $(shell $(CC) -mthumb -mcpu=cortex-m4 -mfpu=fpv4-sp-d16 -mfloat-abi=softfp --print-file-name=libm.a)

$(BUILD)/sqlite_port.o: sqlite3-adapted.inc
