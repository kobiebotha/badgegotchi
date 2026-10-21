import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  BadgeRepository, dayKeyFor, endSession, formatDuration, pauseSession,
  plannedDurationFor, remainingSeconds, resumeSession, idleTimer, replayTimer, pendingCommandFromRow,
  accountProjection, timerSession, ACTIVE_PET_EVENT_QUERY, accountPetIsThinking,
} from '../src/domain';
import type { BadgeDatabase, SessionRecord } from '../src/domain';

const start = new Date('2026-10-20T15:00:00.000Z');
const later = (seconds: number) => new Date(start.getTime() + seconds * 1000);
const active: SessionRecord = {
  id: 'session', dayKey: '2026-10-20', type: 'focus', plannedDurationSeconds: 2400,
  state: 'active', outcome: null, startedAt: start.toISOString(), lastResumedAt: start.toISOString(),
  pausedAt: null, endedAt: null, remainingSecondsAtPause: null,
};

describe('timer behavior', () => {
  it('preserves 40-minute focus / 10-minute break and UTC day keys across devices', () => {
    expect(plannedDurationFor('focus')).toBe(2400);
    expect(plannedDurationFor('break')).toBe(600);
    expect(dayKeyFor(new Date('2026-10-20T23:30:00-06:00'))).toBe('2026-10-21');
    expect(formatDuration(2400)).toBe('40:00');
  });

  it('catches up from wall-clock time after a background tab sleeps', () => {
    expect(remainingSeconds(active, later(10))).toBe(2390);
    expect(remainingSeconds(active, later(2800))).toBe(0);
    expect(remainingSeconds(active, later(-60))).toBe(2400);
  });

  it('freezes time while paused, resumes from the saved balance, and clears pause state', () => {
    const paused = pauseSession(active, later(125));
    expect(remainingSeconds(paused, later(3600))).toBe(2275);
    const resumed = resumeSession(paused, later(3600));
    expect(resumed.pausedAt).toBeNull();
    expect(remainingSeconds(resumed, later(3660))).toBe(2215);
    const ended = endSession(resumed, 'stopped', later(3660));
    expect(resumeSession(ended, later(3700))).toBe(ended);
    expect(remainingSeconds(ended, later(3700))).toBe(0);
  });
});


// Real SQLite transactions exercise the durable intent queue without a cloud.
describe('shared account command repository', () => {
  let sqlite: DatabaseSync;
  let repository: BadgeRepository;
  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`
      CREATE TABLE badge_projection(id TEXT PRIMARY KEY, kind TEXT, payload TEXT);
      CREATE TABLE pending_commands(id TEXT PRIMARY KEY,payload TEXT,status TEXT,receipt TEXT,created_at TEXT,sequence INTEGER);
      CREATE TABLE account_commands(id TEXT PRIMARY KEY,payload TEXT);
      CREATE TABLE wellness_events(id TEXT PRIMARY KEY);
      CREATE TABLE pet_events(id TEXT PRIMARY KEY);
      CREATE TABLE pet_sessions(id TEXT PRIMARY KEY,updated_at TEXT);
    `);
    type Params = (string | number | null)[];
    interface Adapter {
      get(sql: string, p?: Params): Promise<Record<string, unknown>>;
      getOptional(sql: string, p?: Params): Promise<Record<string, unknown> | null>;
      getAll(sql: string, p?: Params): Promise<Record<string, unknown>[]>;
      execute(sql: string, p?: Params): Promise<unknown>;
      writeTransaction<T>(callback: (tx: Adapter) => Promise<T>): Promise<T>;
    }
    const adapter: Adapter = {
      async get(sql, p = []) { const row = sqlite.prepare(sql).get(...p); if (!row) throw new Error('No row'); return row; },
      async getOptional(sql, p = []) { return sqlite.prepare(sql).get(...p) ?? null; },
      async getAll(sql, p = []) { return sqlite.prepare(sql).all(...p); },
      async execute(sql, p = []) { return sqlite.prepare(sql).run(...p); },
      async writeTransaction(callback) {
        sqlite.exec('BEGIN');
        try { const value = await callback(adapter); sqlite.exec('COMMIT'); return value; }
        catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      },
    };
    let next = 0;
    repository = new BadgeRepository(adapter as unknown as BadgeDatabase, 'owner', () => `id-${++next}`);
    seedTimer(idleTimer());
  });
  afterEach(() => sqlite.close());
  function seedTimer(timer: ReturnType<typeof idleTimer>) {
    sqlite.prepare("INSERT OR REPLACE INTO badge_projection VALUES ('owner:timer','timer',?)").run(JSON.stringify(timer));
  }
  function pending() { return sqlite.prepare('SELECT * FROM pending_commands ORDER BY sequence').all().map(pendingCommandFromRow); }
  function timer() {
    const canonical = accountProjection(sqlite.prepare('SELECT kind,payload FROM badge_projection').all()).timer!;
    return replayTimer(canonical, pending());
  }
  it('queues wellness without fabricating confirmed totals or independently enqueueing AI', async () => {
    await repository.logWellness('hydration', start);
    await repository.logWellness('movement', later(1));
    expect(pending().map(p => p.command.type)).toEqual(['hydration','movement']);
    expect(sqlite.prepare('SELECT * FROM wellness_events').all()).toEqual([]);
    expect(sqlite.prepare('SELECT * FROM pet_events').all()).toEqual([]);
    expect(sqlite.prepare('SELECT count(*) AS count FROM account_commands').get()?.count).toBe(2);
  });
  it('chains offline start/pause/resume using revisions and persists its original time balance', async () => {
    await repository.startSession('focus', start);
    await repository.pauseSession('id-1', later(125));
    await repository.resumeSession('id-1', later(3600));
    expect(pending().map(p => p.command.expected_revision)).toEqual(['0','1','2']);
    expect(timer().state).toBe('active');
    expect(remainingSeconds(timerSession(timer())!, later(3660))).toBe(2215);
    expect(accountProjection(sqlite.prepare('SELECT * FROM badge_projection').all()).timer?.state).toBe('idle');
  });
  it('completes once and makes the opposite phase paused with a stable successor ID', async () => {
    await repository.startSession('focus', start);
    await repository.completeExpiredSession('id-1', later(2401));
    await repository.completeExpiredSession('id-1', later(2402));
    expect(pending()).toHaveLength(2);
    expect(timer()).toMatchObject({ id:'id-2', type:'break', state:'paused', planned_duration_seconds:600, revision:'2' });
    await repository.resumeSession('id-2', later(2500));
    expect(pending()[2].command).toMatchObject({ type:'timer_resume', session_id:'id-2', expected_revision:'2' });
    await repository.completeExpiredSession('id-2', later(3101));
    expect(timer()).toMatchObject({ id:'id-4', type:'focus', state:'paused', planned_duration_seconds:2400 });
  });
  it('stop resets the same shared phase paused, and overdue stop completes instead', async () => {
    await repository.startSession('focus', start);
    await repository.endSession('id-1', 'stopped', later(10));
    expect(timer()).toMatchObject({ type:'focus', state:'paused', remaining_seconds_at_pause:2400 });
    await repository.resumeSession('id-2', later(20));
    await repository.endSession('id-2', 'stopped', later(2421));
    expect(pending().at(-1)?.command.type).toBe('timer_complete');
    expect(timer().type).toBe('break');
  });
  it('rejects a second start and requires an initial authoritative timer snapshot', async () => {
    await repository.startSession('focus', start);
    await expect(repository.startSession('focus', later(1))).rejects.toThrow('already has a timer');
    sqlite.exec('DELETE FROM badge_projection');
    await expect(repository.pauseSession('id-1', later(2))).rejects.toThrow('Connect once');
  });
  it('does not replay stale commands over a newer timer downloaded from another device', async () => {
    await repository.startSession('focus', start);
    seedTimer({ ...idleTimer(), revision:'7' });
    expect(timer()).toMatchObject({ revision:'7', state:'idle' });
  });
  it('retains accepted controls until their canonical revision arrives, preventing snapback', async () => {
    await repository.startSession('focus', start);
    const acceptedTimer = timer();
    sqlite.prepare("UPDATE pending_commands SET status='accepted',receipt=?").run(JSON.stringify({ state:'accepted',command_id:'id-1',revision:'1',timer:acceptedTimer }));
    await repository.reconcileConfirmed();
    expect(pending()).toHaveLength(1);
    expect(timer().state).toBe('active');
    seedTimer(acceptedTimer);
    await repository.reconcileConfirmed();
    expect(pending()).toHaveLength(0);
    expect(timer().state).toBe('active');
  });
  it('only retires accepted wellness when its canonical event arrives', async () => {
    await repository.logWellness('hydration', start);
    sqlite.prepare("UPDATE pending_commands SET status='accepted',receipt=?").run(JSON.stringify({ state:'accepted',command_id:'id-1',revision:'0' }));
    await repository.reconcileConfirmed();
    expect(pending()).toHaveLength(1);
    sqlite.exec("INSERT INTO wellness_events VALUES ('id-1')");
    await repository.reconcileConfirmed();
    expect(pending()).toHaveLength(0);
  });
  it('retires an accepted event deleted by a later shared reset checkpoint', async () => {
    await repository.logWellness('hydration', start);
    sqlite.prepare("UPDATE pending_commands SET status='accepted',receipt=?").run(JSON.stringify({state:'accepted',command_id:'id-1',revision:'0'}));
    await repository.reconcileConfirmed();
    expect(pending()).toHaveLength(1);
    seedTimer({...idleTimer(),revision:'1'});
    await repository.reconcileConfirmed();
    expect(pending()).toHaveLength(0);
  });
  it('binds pet actions to the synced pet identity and preserves every press', async () => {
    await expect(repository.enqueuePetEvent('pet_pet', start)).rejects.toThrow('load your companion');
    sqlite.prepare('INSERT INTO pet_sessions VALUES (?,?)').run('pet', start.toISOString());
    await repository.enqueuePetEvent('pet_pet', start);
    expect(pending()[0].command).toMatchObject({ type:'pet',pet_session_id:'pet' });
  });
  it('rolls back local status when the durable PowerSync intent cannot be stored', async () => {
    sqlite.exec("CREATE TRIGGER reject_command BEFORE INSERT ON account_commands BEGIN SELECT RAISE(ABORT,'disk full'); END;");
    await expect(repository.logWellness('hydration', start)).rejects.toThrow('disk full');
    expect(pending()).toHaveLength(0);
  });
  it('handles revisions beyond the JS integer precision boundary exactly', async () => {
    seedTimer({ ...idleTimer(), revision:'9007199254740993' });
    await repository.startSession('focus', start);
    expect(timer().revision).toBe('9007199254740994');
  });
  it('queues reset as one account action without deleting cached canonical history', async () => {
    sqlite.exec("INSERT INTO wellness_events VALUES ('existing')");
    await repository.resetDay('2026-10-20', start);
    expect(pending()[0].command).toMatchObject({ type:'reset_day',day_key:'2026-10-20',expected_revision:'0' });
    expect(sqlite.prepare('SELECT * FROM wellness_events').all()).toHaveLength(1);
  });
});

describe('shared latest pet reaction', () => {
  it('ignores an older retry when the latest projected reaction is complete', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`CREATE TABLE badge_projection(kind TEXT,payload TEXT);
        CREATE TABLE pet_events(id TEXT,pet_session_id TEXT,status TEXT,event_type TEXT);`);
      db.exec("INSERT INTO pet_events VALUES ('old','pet','pending','drink_water'),('new','pet','completed','pet_pet')");
      const projection = {id:'pet',latest_event_id:'new',status:'completed' as const};
      db.prepare('INSERT INTO badge_projection VALUES (?,?)').run('pet',JSON.stringify(projection));
      expect(db.prepare(ACTIVE_PET_EVENT_QUERY).all()).toEqual([]);
      expect(accountPetIsThinking(projection)).toBe(false);
      db.prepare('UPDATE badge_projection SET payload=?').run(JSON.stringify({...projection,latest_event_id:'old',status:'pending'}));
      expect(db.prepare(ACTIVE_PET_EVENT_QUERY).all()).toEqual([{id:'old',pet_session_id:'pet',status:'pending',event_type:'drink_water'}]);
      expect(accountPetIsThinking({...projection,status:'pending'})).toBe(true);
      expect(accountPetIsThinking({...projection,status:'processing'})).toBe(true);
      expect(accountPetIsThinking({...projection,status:'failed'})).toBe(false);
    } finally { db.close(); }
  });
});
