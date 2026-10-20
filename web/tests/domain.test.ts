import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  BadgeRepository, dayKeyFor, endSession, formatDuration, pauseSession,
  plannedDurationFor, remainingSeconds, resumeSession,
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

// Execute real SQL against SQLite. Only the async SDK adapter is replaced;
// domain state transitions, transactions, joins, and projections stay intact.
describe('local PowerSync repository contracts', () => {
  let sqlite: DatabaseSync;
  let repository: BadgeRepository;
  let writes: string[];

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, day_key TEXT, type TEXT, planned_duration_seconds INTEGER,
        state TEXT, outcome TEXT, started_at TEXT, last_resumed_at TEXT, paused_at TEXT,
        ended_at TEXT, remaining_seconds_at_pause INTEGER
      );
      CREATE TABLE wellness_events (id TEXT PRIMARY KEY, day_key TEXT, type TEXT, occurred_at TEXT);
      CREATE TABLE daily_activity_summary (
        id TEXT PRIMARY KEY, day_key TEXT, ended_focus_count INTEGER, ended_break_count INTEGER,
        hydration_count INTEGER, movement_count INTEGER, last_hydration_at TEXT,
        hydration_timer_anchor_at TEXT, hydration_reminder_active INTEGER, updated_at TEXT
      );
      CREATE TABLE pet_sessions (
        id TEXT PRIMARY KEY, animal_id TEXT, bio_name TEXT, bio_summary TEXT,
        latest_speech TEXT, latest_event_id TEXT, last_error TEXT, created_at TEXT, updated_at TEXT
      );
      CREATE TABLE pet_events (
        id TEXT PRIMARY KEY, pet_session_id TEXT, event_type TEXT, source_device TEXT,
        status TEXT, reaction_speech TEXT, error_message TEXT, created_at TEXT,
        claimed_at TEXT, completed_at TEXT
      );
    `);
    writes = [];
    type Params = (string | number | null)[];
    interface TestAdapter {
      get(sql: string, params?: Params): Promise<Record<string, unknown>>;
      getOptional(sql: string, params?: Params): Promise<Record<string, unknown> | null>;
      getAll(sql: string, params?: Params): Promise<Record<string, unknown>[]>;
      execute(sql: string, params?: Params): Promise<unknown>;
      writeTransaction<T>(callback: (tx: TestAdapter) => Promise<T>): Promise<T>;
    }
    const adapter: TestAdapter = {
      async get(sql: string, params: Params = []) {
        const row = sqlite.prepare(sql).get(...params);
        if (!row) throw new Error('Row not found');
        return row;
      },
      async getOptional(sql: string, params: Params = []) {
        return sqlite.prepare(sql).get(...params) ?? null;
      },
      async getAll(sql: string, params: Params = []) {
        return sqlite.prepare(sql).all(...params);
      },
      async execute(sql: string, params: Params = []) {
        writes.push(sql);
        return sqlite.prepare(sql).run(...params);
      },
      async writeTransaction<T>(callback: (tx: TestAdapter) => Promise<T>): Promise<T> {
        sqlite.exec('BEGIN');
        try {
          const result = await callback(adapter);
          sqlite.exec('COMMIT');
          return result;
        } catch (error) {
          sqlite.exec('ROLLBACK');
          throw error;
        }
      },
    };
    let nextId = 0;
    repository = new BadgeRepository(adapter as unknown as BadgeDatabase, 'owner', () => `id-${++nextId}`);
  });

  afterEach(() => sqlite.close());

  function seedPet() {
    sqlite.prepare(`INSERT INTO pet_sessions
      (id, animal_id, bio_name, bio_summary, latest_speech, created_at, updated_at)
      VALUES (?, 'cat', 'Mochi', 'A friendly cat', '', ?, ?)`)
      .run('pet', start.toISOString(), start.toISOString());
  }

  function petEvents() {
    return sqlite.prepare('SELECT event_type, source_device FROM pet_events ORDER BY rowid').all();
  }

  it('derives counters from raw records without uploading cached summary counts', async () => {
    const initial = await repository.loadSummary('2026-10-20', start);
    expect(initial.id).toBe('owner:2026-10-20');
    expect(writes).toEqual([]);
    const focus = await repository.startSession('focus', start);
    await repository.endSession(focus.id, 'stopped', later(20));
    await repository.logWellness('hydration', later(30));
    // Downloaded records from another device must contribute immediately.
    sqlite.prepare("INSERT INTO wellness_events VALUES ('remote', '2026-10-20', 'hydration', ?)")
      .run(later(60).toISOString());
    const summary = await repository.loadSummary('2026-10-20', later(60));
    expect(summary.endedFocusCount).toBe(1);
    expect(summary.hydrationCount).toBe(2);
    expect(summary.lastHydrationAt).toBe(later(60).toISOString());
    expect(writes.some((sql) => /(?:INSERT|UPDATE).*daily_activity_summary/s.test(sql))).toBe(false);
  });

  it('queues web pet intentions atomically and does not duplicate repeated completion ticks', async () => {
    seedPet();
    const session = await repository.startSession('focus', start);
    await repository.completeExpiredSession(session.id, later(2401));
    await repository.completeExpiredSession(session.id, later(2402));
    await repository.endSession(session.id, 'stopped', later(2403));
    expect(petEvents()).toEqual([
      { event_type: 'start_focus_session', source_device: 'web' },
      { event_type: 'complete_focus_session', source_device: 'web' },
    ]);
    const snapshot = await repository.loadSnapshot('2026-10-20', later(2403));
    expect(snapshot.activeSession).toBeNull();
    expect(snapshot.summary.endedFocusCount).toBe(1);
    expect(snapshot.sessions[0].outcome).toBe('completed');
  });

  it.each(['pause', 'stop'] as const)('reconciles an expired timer before %s', async (action) => {
    seedPet();
    const session = await repository.startSession('focus', start);
    const result = action === 'pause'
      ? await repository.pauseSession(session.id, later(2400))
      : await repository.endSession(session.id, 'stopped', later(2400));
    expect(result.state).toBe('ended');
    expect(result.outcome).toBe('completed');
    expect(petEvents().at(-1)?.event_type).toBe('complete_focus_session');
  });

  it('only has one running session and never counts pause time', async () => {
    const focus = await repository.startSession('focus', start);
    await repository.pauseSession(focus.id, later(125));
    await repository.completeExpiredSession(focus.id, later(7200));
    const resumed = await repository.resumeSession(focus.id, later(7200));
    expect(remainingSeconds(resumed, later(7260))).toBe(2215);
    expect(resumed.pausedAt).toBeNull();
    await repository.startSession('break', later(7260));
    const snapshot = await repository.loadSnapshot('2026-10-20', later(7260));
    expect(snapshot.activeSession?.type).toBe('break');
    expect(snapshot.sessions.filter((session) => session.state !== 'ended')).toHaveLength(1);
    expect(snapshot.summary.endedFocusCount).toBe(1);
  });

  it('clears reminders for a newer drink but preserves a later reminder anchor', async () => {
    await repository.setHydrationReminderState('2026-10-20', later(100), true);
    await repository.logWellness('hydration', later(120));
    let summary = await repository.loadSummary('2026-10-20', later(120));
    expect(summary.hydrationReminderActive).toBe(false);
    expect(summary.hydrationTimerAnchorAt).toBe(later(120).toISOString());
    await repository.setHydrationReminderState('2026-10-20', later(200), true);
    summary = await repository.loadSummary('2026-10-20', later(220));
    expect(summary.hydrationReminderActive).toBe(true);
    expect(summary.hydrationTimerAnchorAt).toBe(later(200).toISOString());
  });

  it('logs wellness while the pet is thinking without adding another wellness reaction', async () => {
    seedPet();
    await repository.startSession('focus', start);
    await repository.logWellness('hydration', later(20));
    await repository.logWellness('movement', later(30));
    const summary = await repository.loadSummary('2026-10-20', later(30));
    expect(summary.hydrationCount).toBe(1);
    expect(summary.movementCount).toBe(1);
    expect(petEvents()).toHaveLength(1);
  });

  it('resets only the requested day and handles stale completion calls after reset', async () => {
    const session = await repository.startSession('focus', start);
    await repository.logWellness('movement', later(60));
    sqlite.prepare("INSERT INTO wellness_events VALUES ('yesterday', '2026-10-19', 'hydration', ?)")
      .run('2026-10-19T15:00:00Z');
    await repository.resetDay('2026-10-20', later(70));
    expect(await repository.completeExpiredSession(session.id, later(2400))).toBeNull();
    const summary = await repository.loadSummary('2026-10-20', later(80));
    expect(summary.movementCount).toBe(0);
    expect(summary.hydrationTimerAnchorAt).toBe(later(70).toISOString());
    expect((await repository.loadSummary('2026-10-19', start)).hydrationCount).toBe(1);
  });

  it('rolls back local activity if the related pet intention cannot be saved', async () => {
    seedPet();
    sqlite.exec("CREATE TRIGGER reject_pet BEFORE INSERT ON pet_events BEGIN SELECT RAISE(ABORT, 'disk write failed'); END;");
    await expect(repository.logWellness('hydration', start)).rejects.toThrow('disk write failed');
    expect(sqlite.prepare('SELECT count(*) AS count FROM wellness_events').get()?.count).toBe(0);
  });
});
