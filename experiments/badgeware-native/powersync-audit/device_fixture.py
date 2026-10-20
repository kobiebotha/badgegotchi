"""Adapters for badge_powersync.exec(), which returns text/None column values.

The caller owns opening/closing the database and installing any Python VFS.
Example:
    import badge_powersync as db, device_fixture
    db.open(":memory:")
    device_fixture.fresh(db)
    db.close()

For persistence, call fresh() on a new isolated file, close/reopen, then call
reopened(). Never run fresh() against an existing non-test database.
"""
import fixture


def adapter(module):
    def execute(sql):
        module.exec(sql)

    def scalar(sql):
        rows = module.exec(sql)
        assert len(rows) == 1 and len(rows[0]) >= 1, (sql, rows)
        value = rows[0][0]
        if isinstance(value, str):
            digits = value[1:] if value.startswith("-") else value
            if digits and all("0" <= ch <= "9" for ch in digits):
                return int(value)
        return value

    return execute, scalar


def fresh(module):
    execute, scalar = adapter(module)
    result = fixture.fresh(execute, scalar)
    print("PASS real core fresh:", result)
    print("CORE STATS:", module.stats())
    return result


def reopened(module):
    execute, scalar = adapter(module)
    result = fixture.reopened(execute, scalar)
    print("PASS real core reopened:", result)
    print("CORE STATS:", module.stats())
    return result
