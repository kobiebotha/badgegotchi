import type { PowerSyncDatabase } from "@powersync/web";
import { isLifecycleEvent } from "./animals";
import {
  ACTIVE_PET_EVENT_QUERY,
  ACTIVE_SESSION_QUERY,
  CURRENT_PET_QUERY,
  DAILY_SUMMARY_QUERY,
  TODAY_SESSIONS_QUERY,
  WELLNESS_QUERY,
  dailySummaryParameters,
} from "./queries";
import {
  petEventFromRow,
  petSessionFromRow,
  sessionFromRow,
  summaryFromRow,
  wellnessFromRow,
} from "./rows";
import type { DatabaseRow } from "./rows";
import { dayKeyFor, plannedDurationFor, remainingSeconds } from "./timer";
import type {
  BadgeSnapshot,
  DailySummary,
  PetEventRecord,
  PetEventType,
  SessionOutcome,
  SessionRecord,
  SessionType,
  WellnessEvent,
  WellnessType,
} from "./types";

export type BadgeDatabase = Pick<
  PowerSyncDatabase,
  "get" | "getAll" | "getOptional" | "execute" | "writeTransaction"
>;
type WriteTransaction = Parameters<
  Parameters<PowerSyncDatabase["writeTransaction"]>[0]
>[0];

/**
 * All commands write through PowerSync so they are available offline and upload
 * normally. Related pet intentions share the timer/wellness transaction.
 */
export class BadgeRepository {
  private readonly summaryOpenedAt = new Map<string, Date>();

  constructor(
    private readonly database: BadgeDatabase,
    private readonly userId: string,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {
    if (!userId)
      throw new Error("Sign in before opening your activity history.");
  }

  summaryParameters(dayKey: string, now = new Date()): string[] {
    let openedAt = this.summaryOpenedAt.get(dayKey);
    if (!openedAt) {
      openedAt = now;
      this.summaryOpenedAt.set(dayKey, openedAt);
    }
    return dailySummaryParameters(dayKey, this.userId, openedAt);
  }

  async loadSummary(dayKey: string, now = new Date()): Promise<DailySummary> {
    const row = await this.database.get<DatabaseRow>(
      DAILY_SUMMARY_QUERY,
      this.summaryParameters(dayKey, now),
    );
    return summaryFromRow(row);
  }

  async loadSnapshot(dayKey: string, now = new Date()): Promise<BadgeSnapshot> {
    const [active, sessions, wellness, summary, pet, activePetEvent] =
      await Promise.all([
        this.database.getOptional<DatabaseRow>(ACTIVE_SESSION_QUERY),
        this.database.getAll<DatabaseRow>(TODAY_SESSIONS_QUERY, [dayKey]),
        this.database.getAll<DatabaseRow>(WELLNESS_QUERY, [dayKey]),
        this.loadSummary(dayKey, now),
        this.database.getOptional<DatabaseRow>(CURRENT_PET_QUERY),
        this.database.getOptional<DatabaseRow>(ACTIVE_PET_EVENT_QUERY),
      ]);
    return {
      activeSession: active ? sessionFromRow(active) : null,
      sessions: sessions.map(sessionFromRow),
      wellnessEvents: wellness.map(wellnessFromRow),
      summary,
      pet: pet ? petSessionFromRow(pet) : null,
      activePetEvent: activePetEvent ? petEventFromRow(activePetEvent) : null,
    };
  }

  async startSession(
    type: SessionType,
    now = new Date(),
  ): Promise<SessionRecord> {
    const id = this.newId();
    const stamp = now.toISOString();
    return this.database.writeTransaction(async (tx) => {
      const active = await tx.getAll<DatabaseRow>(
        "SELECT * FROM sessions WHERE state IN ('active', 'paused')",
      );
      for (const row of active) {
        const session = sessionFromRow(row);
        const outcome = this.hasExpired(session, now) ? "completed" : "stopped";
        await this.finish(tx, session, outcome, now);
      }
      await tx.execute(
        `INSERT INTO sessions
        (id, day_key, type, planned_duration_seconds, state, outcome, started_at,
         last_resumed_at, paused_at, ended_at, remaining_seconds_at_pause)
        VALUES (?, ?, ?, ?, 'active', NULL, ?, ?, NULL, NULL, NULL)`,
        [id, dayKeyFor(now), type, plannedDurationFor(type), stamp, stamp],
      );
      await this.queuePet(
        tx,
        type === "focus" ? "start_focus_session" : "start_break",
        now,
      );
      return this.session(tx, id);
    });
  }

  async pauseSession(id: string, now = new Date()): Promise<SessionRecord> {
    return this.database.writeTransaction(async (tx) => {
      const session = await this.session(tx, id);
      if (session.state !== "active") return session;
      if (this.hasExpired(session, now))
        return this.finish(tx, session, "completed", now);
      await tx.execute(
        "UPDATE sessions SET state = 'paused', paused_at = ?, remaining_seconds_at_pause = ? WHERE id = ?",
        [now.toISOString(), remainingSeconds(session, now), id],
      );
      if (session.type === "focus")
        await this.queuePet(tx, "pause_focus_session", now);
      return this.session(tx, id);
    });
  }

  async resumeSession(id: string, now = new Date()): Promise<SessionRecord> {
    return this.database.writeTransaction(async (tx) => {
      const session = await this.session(tx, id);
      if (session.state !== "paused") return session;
      await tx.execute(
        "UPDATE sessions SET state = 'active', last_resumed_at = ?, paused_at = NULL WHERE id = ?",
        [now.toISOString(), id],
      );
      if (session.type === "focus")
        await this.queuePet(tx, "resume_focus_session", now);
      return this.session(tx, id);
    });
  }

  async endSession(
    id: string,
    outcome: SessionOutcome,
    now = new Date(),
  ): Promise<SessionRecord> {
    return this.database.writeTransaction(async (tx) => {
      const session = await this.session(tx, id);
      if (session.state === "ended") return session;
      return this.finish(
        tx,
        session,
        this.hasExpired(session, now) ? "completed" : outcome,
        now,
      );
    });
  }

  /** Safe to call on interval, focus/visibility changes, and concurrently in tabs. */
  async completeExpiredSession(
    id: string,
    now = new Date(),
  ): Promise<SessionRecord | null> {
    return this.database.writeTransaction(async (tx) => {
      // A reset or another tab may have removed the row since it was rendered.
      const row = await tx.getOptional<DatabaseRow>(
        "SELECT * FROM sessions WHERE id = ?",
        [id],
      );
      if (!row) return null;
      const session = sessionFromRow(row);
      if (!this.hasExpired(session, now)) return session;
      return this.finish(tx, session, "completed", now);
    });
  }

  async logWellness(
    type: WellnessType,
    now = new Date(),
  ): Promise<WellnessEvent> {
    const id = this.newId();
    const event: WellnessEvent = {
      id,
      type,
      dayKey: dayKeyFor(now),
      occurredAt: now.toISOString(),
    };
    await this.database.writeTransaction(async (tx) => {
      await tx.execute(
        "INSERT INTO wellness_events (id, day_key, type, occurred_at) VALUES (?, ?, ?, ?)",
        [id, event.dayKey, type, event.occurredAt],
      );
      await this.queuePet(
        tx,
        type === "hydration" ? "drink_water" : "move_or_stretch",
        now,
      );
    });
    return event;
  }

  async enqueuePetEvent(
    type: PetEventType,
    now = new Date(),
  ): Promise<PetEventRecord | null> {
    return this.database.writeTransaction((tx) => this.queuePet(tx, type, now));
  }

  async setHydrationReminderState(
    dayKey: string,
    anchorAt: Date,
    isActive: boolean,
  ): Promise<DailySummary> {
    const id = `${this.userId}:${dayKey}`;
    const stamp = anchorAt.toISOString();
    await this.database.writeTransaction(async (tx) => {
      const existing = await tx.getOptional(
        "SELECT id FROM daily_activity_summary WHERE id = ?",
        [id],
      );
      if (existing) {
        await tx.execute(
          `UPDATE daily_activity_summary SET hydration_timer_anchor_at = ?,
           hydration_reminder_active = ?, updated_at = ? WHERE id = ?`,
          [stamp, isActive ? 1 : 0, stamp, id],
        );
      } else {
        await tx.execute(
          `INSERT INTO daily_activity_summary
           (id, day_key, hydration_timer_anchor_at, hydration_reminder_active, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
          [id, dayKey, stamp, isActive ? 1 : 0, stamp],
        );
      }
    });
    return this.loadSummary(dayKey, anchorAt);
  }

  async resetDay(dayKey: string, now = new Date()): Promise<void> {
    await this.database.writeTransaction(async (tx) => {
      await tx.execute("DELETE FROM sessions WHERE day_key = ?", [dayKey]);
      await tx.execute("DELETE FROM wellness_events WHERE day_key = ?", [
        dayKey,
      ]);
      await tx.execute("DELETE FROM daily_activity_summary WHERE day_key = ?", [
        dayKey,
      ]);
    });
    this.summaryOpenedAt.set(dayKey, now);
  }

  private hasExpired(session: SessionRecord, now: Date): boolean {
    return session.state === "active" && remainingSeconds(session, now) === 0;
  }

  private async session(
    tx: WriteTransaction,
    id: string,
  ): Promise<SessionRecord> {
    return sessionFromRow(
      await tx.get<DatabaseRow>("SELECT * FROM sessions WHERE id = ?", [id]),
    );
  }

  private async finish(
    tx: WriteTransaction,
    session: SessionRecord,
    outcome: SessionOutcome,
    now: Date,
  ): Promise<SessionRecord> {
    await tx.execute(
      "UPDATE sessions SET state = 'ended', outcome = ?, ended_at = ?, paused_at = NULL WHERE id = ?",
      [outcome, now.toISOString(), session.id],
    );
    const event: PetEventType =
      session.type === "focus"
        ? outcome === "completed"
          ? "complete_focus_session"
          : "stop_focus_session_early"
        : outcome === "completed"
          ? "complete_break"
          : "stop_break_early";
    await this.queuePet(tx, event, now);
    return this.session(tx, session.id);
  }

  private async queuePet(
    tx: WriteTransaction,
    eventType: PetEventType,
    now: Date,
  ): Promise<PetEventRecord | null> {
    const pet = await tx.getOptional<{ id: string }>(CURRENT_PET_QUERY);
    // Initial cloud pet setup must not block local timer/wellness actions.
    if (!pet) return null;
    // Match the native app: wellness is still logged while the pet is thinking,
    // but only lifecycle intentions are allowed to extend its reaction queue.
    if (!isLifecycleEvent(eventType)) {
      const active = await tx.getOptional(
        "SELECT id FROM pet_events WHERE pet_session_id = ? AND status IN ('pending', 'processing') LIMIT 1",
        [pet.id],
      );
      if (active) return null;
    }
    const id = this.newId();
    const stamp = now.toISOString();
    await tx.execute(
      `INSERT INTO pet_events
       (id, pet_session_id, event_type, source_device, status, reaction_speech,
        error_message, created_at, claimed_at, completed_at)
       VALUES (?, ?, ?, 'web', 'pending', NULL, NULL, ?, NULL, NULL)`,
      [id, pet.id, eventType, stamp],
    );
    return {
      id,
      petSessionId: pet.id,
      eventType,
      sourceDevice: "web",
      status: "pending",
      reactionSpeech: null,
      errorMessage: null,
      createdAt: stamp,
      claimedAt: null,
      completedAt: null,
    };
  }
}
