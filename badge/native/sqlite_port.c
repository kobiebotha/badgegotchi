/* Use the exact feature profile and checked transformations from feasibility. */
#include "config.h"
#define SQLITE_OMIT_WSD 1
#define SQLITE_OMIT_DESERIALIZE 1
#define SQLITE_OMIT_EXPLAIN 1
#include "sqlite3-adapted.inc"
