/* Reuse the exact constrained standalone SQL feature profile; adapt storage and WSD. */
#include "/Users/kobie/projects/powersync/skunkworks/powerbadge/native/sqlite-hello/sqlite/config.h"
#define SQLITE_OMIT_WSD 1
#define SQLITE_OMIT_DESERIALIZE 1
#define SQLITE_OMIT_EXPLAIN 1
#include "sqlite3-adapted.inc"
