MOD = badgegotchi_native
BUILD = build
POWERBADGE ?= /Users/kobie/projects/powersync/skunkworks/powerbadge
EXPERIMENT = ../../experiments/badgeware-native
MPY_DIR = $(EXPERIMENT)/vendor/micropython-41d1e007537f9b15cf13a9436228dd59d6485eca
ARCH = armv7emsp
SRC = module.c sqlite_port.c libc_shim.c vfs.c
LINK_RUNTIME = 1
CFLAGS_EXTRA += -DBADGE_POWERSYNC -DMICROPY_OBJ_REPR=MICROPY_OBJ_REPR_C -fno-builtin -fdata-sections -mfloat-abi=softfp
CFLAGS_EXTRA += -I$(POWERBADGE)/native/sqlite-hello/vendor/sqlite-littlefs-vfs/vendor/sqlite -I$(POWERBADGE)/native/sqlite-hello/sqlite
CFLAGS_EXTRA += -Wno-misleading-indentation -Wno-unused-value -Wno-unused-function -Wno-unused-variable -Wno-unused-but-set-variable -Wno-sign-compare
MPY_LD_FLAGS += -l$(EXPERIMENT)/powersync-audit/build/thumbv8m.main-none-eabi/release/libpowersync.a
include $(MPY_DIR)/py/dynruntime.mk
LIBGCC_PATH = $(shell $(CC) -mthumb -mcpu=cortex-m4 -mfpu=fpv4-sp-d16 -mfloat-abi=softfp --print-libgcc-file-name)
LIBM_PATH = $(shell $(CC) -mthumb -mcpu=cortex-m4 -mfpu=fpv4-sp-d16 -mfloat-abi=softfp --print-file-name=libm.a)
$(BUILD)/sqlite_port.o: sqlite3-adapted.inc
