import type { PowerSyncDatabase } from "@powersync/web";
import type { DatabaseRow } from "./rows";
import { remainingSeconds } from "./timer";
import type { SessionOutcome, SessionType, WellnessType } from "./types";
import {
  ACCOUNT_PROJECTION_QUERY, PENDING_COMMANDS_QUERY, accountProjection,
  pendingCommandFromRow, replayTimer, timerSession,
} from "./shared";
import type { AccountCommand, AccountCommandType, PendingCommand } from "./shared";

export type BadgeDatabase = Pick<PowerSyncDatabase,
  "get" | "getAll" | "getOptional" | "execute" | "writeTransaction">;
type WriteTransaction = Parameters<Parameters<PowerSyncDatabase["writeTransaction"]>[0]>[0];

/** Store intentions durably; PowerSync alone supplies confirmed account data. */
export class BadgeRepository {
  constructor(private readonly database: BadgeDatabase, private readonly userId: string,
    private readonly newId: () => string = () => crypto.randomUUID()) {
    if (!userId) throw new Error("Sign in before opening your activity history.");
  }

  async startSession(type: SessionType, now = new Date()): Promise<void> {
    await this.timerCommand("timer_start", null, now, type);
  }
  async pauseSession(id: string, now = new Date()): Promise<void> {
    await this.timerCommand("timer_pause", id, now);
  }
  async resumeSession(id: string, now = new Date()): Promise<void> {
    await this.timerCommand("timer_resume", id, now);
  }
  async endSession(id: string, outcome: SessionOutcome, now = new Date()): Promise<void> {
    await this.timerCommand(outcome === "completed" ? "timer_complete" : "timer_stop", id, now);
  }
  async completeExpiredSession(id: string, now = new Date()): Promise<void> {
    await this.timerCommand("timer_complete", id, now);
  }
  async logWellness(type: WellnessType, now = new Date()): Promise<void> {
    await this.enqueue({ id: this.newId(), type, occurred_at: now.toISOString() });
  }
  async enqueuePetEvent(type: "pet_pet", now = new Date()): Promise<void> {
    if (type !== "pet_pet") throw new Error("Timer and wellness reactions are created by the account service.");
    await this.database.writeTransaction(async (tx) => {
      const pet = await tx.getOptional<{ id: string }>("SELECT id FROM pet_sessions ORDER BY updated_at DESC LIMIT 1");
      if (!pet) throw new Error("Connect to load your companion before petting it.");
      const pending = (await tx.getAll<DatabaseRow>(PENDING_COMMANDS_QUERY)).map(pendingCommandFromRow);
      await this.writeCommand(tx, { id: this.newId(), type: "pet", pet_session_id: pet.id, occurred_at: now.toISOString() }, pending);
    });
  }

  async resetDay(dayKey: string, now = new Date()): Promise<void> {
    await this.database.writeTransaction(async (tx) => {
      const { timer } = accountProjection(await tx.getAll<DatabaseRow>(ACCOUNT_PROJECTION_QUERY));
      if (!timer) throw new Error("Connect to load your account before resetting today.");
      const pending = (await tx.getAll<DatabaseRow>(PENDING_COMMANDS_QUERY)).map(pendingCommandFromRow);
      if (pending.some((item) => item.status !== "rejected")) throw new Error("Wait for your pending actions to sync before resetting today.");
      await this.writeCommand(tx, { id: this.newId(), type: "reset_day", day_key: dayKey,
        expected_revision: timer.revision, occurred_at: now.toISOString() }, pending);
    });
  }

  async reconcileConfirmed(): Promise<void> {
    await this.database.writeTransaction(async (tx) => {
      const { timer } = accountProjection(await tx.getAll<DatabaseRow>(ACCOUNT_PROJECTION_QUERY));
      const pending = (await tx.getAll<DatabaseRow>(PENDING_COMMANDS_QUERY)).map(pendingCommandFromRow);
      for (const item of pending) {
        if (item.status !== "accepted") continue;
        let confirmed = false;
        if ((item.command.type.startsWith("timer_") || item.command.type === "reset_day")) {
          const revision = item.receipt?.revision ?? item.receipt?.timer?.revision;
          confirmed = revision != null && timer != null && BigInt(timer.revision) >= BigInt(revision);
        } else {
          const table = item.command.type === "pet" ? "pet_events" : "wellness_events";
          confirmed = Boolean(await tx.getOptional(`SELECT id FROM ${table} WHERE id = ?`, [item.id]));
          // A later shared timer revision also proves that a covering account
          // checkpoint arrived. This handles reset_day deleting an accepted
          // event before this browser ever downloads that event's row.
          const revision = item.receipt?.revision;
          if (!confirmed && revision != null && timer != null)
            confirmed = BigInt(timer.revision) > BigInt(revision);
        }
        if (confirmed) await tx.execute("DELETE FROM pending_commands WHERE id = ?", [item.id]);
      }
    });
  }
  async dismissRejections(): Promise<void> {
    await this.database.execute("DELETE FROM pending_commands WHERE status = 'rejected'");
  }

  private async timerCommand(type: AccountCommandType, sessionId: string | null,
    now: Date, sessionType?: SessionType): Promise<void> {
    await this.database.writeTransaction(async (tx) => {
      const projection = accountProjection(await tx.getAll<DatabaseRow>(ACCOUNT_PROJECTION_QUERY));
      if (!projection.timer) throw new Error("Connect once to load your account timer before changing it.");
      const pending = (await tx.getAll<DatabaseRow>(PENDING_COMMANDS_QUERY)).map(pendingCommandFromRow);
      const timer = replayTimer(projection.timer, pending);
      const session = timerSession(timer);
      if (type !== "timer_start" && (!session || timer.id !== sessionId)) return;
      if (type === "timer_complete" && (timer.state !== "active" || remainingSeconds(session!, now) > 0)) return;
      if (type === "timer_pause" && timer.state !== "active") return;
      if (type === "timer_resume" && timer.state !== "paused") return;
      // A stale expired timer waiting for a conflicting remote update must not
      // generate another automatic completion every render tick.
      if (type === "timer_complete" && pending.some((item) => item.status === "rejected" &&
        item.command.type === type && item.command.expected_revision === timer.revision)) return;
      if (type === "timer_start" && timer.state !== "idle")
        throw new Error("Your account already has a timer. Resume or stop that timer first.");
      if ((type === "timer_pause" || type === "timer_stop") && session && timer.state === "active" && remainingSeconds(session, now) === 0)
        type = "timer_complete";
      const id = this.newId();
      const command: AccountCommand = { id, type, occurred_at: now.toISOString(), expected_revision: timer.revision,
        ...(type === "timer_start" ? { new_session_id: id, session_type: sessionType } : { session_id: timer.id! }) };
      await this.writeCommand(tx, command, pending);
    });
  }
  private async enqueue(command: AccountCommand): Promise<void> {
    await this.database.writeTransaction(async (tx) => {
      const pending = (await tx.getAll<DatabaseRow>(PENDING_COMMANDS_QUERY)).map(pendingCommandFromRow);
      await this.writeCommand(tx, command, pending);
    });
  }
  private async writeCommand(tx: WriteTransaction, command: AccountCommand, pending: PendingCommand[]): Promise<void> {
    if (pending.filter((item) => item.status !== "rejected").length >= 64)
      throw new Error("64 actions are waiting to sync. Reconnect before adding more.");
    const payload = JSON.stringify(command);
    const { next } = await tx.get<{ next: number }>("SELECT coalesce(max(sequence), 0) + 1 AS next FROM pending_commands");
    await tx.execute("INSERT INTO pending_commands (id, payload, status, receipt, created_at, sequence) VALUES (?, ?, 'queued', NULL, ?, ?)",
      [command.id, payload, command.occurred_at, next]);
    await tx.execute("INSERT INTO account_commands (id, payload) VALUES (?, ?)", [command.id, payload]);
  }
}
