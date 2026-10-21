import type { DatabaseRow } from "./rows";
import type { SessionRecord, SessionType } from "./types";
import { plannedDurationFor, remainingSeconds } from "./timer";

export interface AccountTimer {
  revision: string;
  id: string | null;
  type: SessionType;
  state: "active" | "paused" | "idle";
  planned_duration_seconds: number;
  started_at: string | null;
  last_resumed_at: string | null;
  paused_at: string | null;
  remaining_seconds_at_pause: number | null;
}
export type AccountCommandType = "hydration" | "movement" | "pet" |
  "reset_day" | "timer_start" | "timer_pause" | "timer_resume" | "timer_complete" | "timer_stop";
export interface AccountCommand {
  id: string;
  type: AccountCommandType;
  occurred_at: string;
  session_id?: string;
  new_session_id?: string;
  pet_session_id?: string;
  day_key?: string;
  session_type?: SessionType;
  expected_revision?: string;
}
export interface CommandReceipt {
  command_id: string;
  state: "accepted" | "rejected";
  reason?: string;
  revision?: string;
  timer?: AccountTimer;
}
export interface PendingCommand {
  id: string;
  command: AccountCommand;
  status: "queued" | "accepted" | "rejected";
  receipt: CommandReceipt | null;
}
export interface AccountPet {
  id: string;
  latest_event_id: string | null;
  status: "pending" | "processing" | "completed" | "failed" | null;
}
export function accountPetIsThinking(pet: AccountPet | undefined): boolean {
  return pet?.status === "pending" || pet?.status === "processing";
}
export interface AccountTotals {
  day_key: string;
  ended_focus_count: number;
  ended_break_count: number;
  hydration_count: number;
  movement_count: number;
  pet_count: number;
}
export const ACCOUNT_PROJECTION_QUERY = "SELECT kind, payload FROM badge_projection";
export const PENDING_COMMANDS_QUERY = "SELECT * FROM pending_commands ORDER BY sequence, created_at, id";
export const idleTimer = (): AccountTimer => ({
  revision: "0", id: null, type: "focus", state: "idle", planned_duration_seconds: 2400,
  started_at: null, last_resumed_at: null, paused_at: null, remaining_seconds_at_pause: 2400,
});

export function accountProjection(rows: DatabaseRow[]) {
  const parsed: Record<string, Record<string, unknown>> = {};
  for (const row of rows) {
    if (typeof row.kind !== "string" || typeof row.payload !== "string") continue;
    const value: unknown = JSON.parse(row.payload);
    if (value && typeof value === "object" && !Array.isArray(value)) parsed[row.kind] = value as Record<string, unknown>;
  }
  const raw = parsed.timer;
  const timer = raw && typeof raw.revision === "string" && /^\d+$/.test(raw.revision)
    ? { ...idleTimer(), ...raw } as AccountTimer : null;
  return { timer, totals: parsed.summary as unknown as AccountTotals | undefined,
    pet: parsed.pet as unknown as AccountPet | undefined };
}
export function pendingCommandFromRow(row: DatabaseRow): PendingCommand {
  return { id: String(row.id), command: JSON.parse(String(row.payload)) as AccountCommand,
    status: String(row.status) as PendingCommand["status"],
    receipt: row.receipt ? JSON.parse(String(row.receipt)) as CommandReceipt : null };
}
export function timerSession(timer: AccountTimer): SessionRecord | null {
  if (!timer.id || timer.state === "idle") return null;
  return { id: timer.id, dayKey: timer.started_at?.slice(0, 10) ?? "", type: timer.type,
    state: timer.state, plannedDurationSeconds: timer.planned_duration_seconds, outcome: null,
    startedAt: timer.started_at ?? "", lastResumedAt: timer.last_resumed_at ?? "",
    pausedAt: timer.paused_at, endedAt: null, remainingSecondsAtPause: timer.remaining_seconds_at_pause };
}
/** Provisional controls are labelled pending. They never change account totals. */
export function replayTimer(canonical: AccountTimer, commands: PendingCommand[]): AccountTimer {
  let timer = canonical;
  for (const item of commands) {
    const command = item.command;
    if (item.receipt?.timer && BigInt(item.receipt.timer.revision) > BigInt(timer.revision)) {
      timer = item.receipt.timer;
    }
    if (item.status === "rejected" || !command.type.startsWith("timer_")) continue;
    if (command.expected_revision !== timer.revision) continue;
    const stamp = command.occurred_at;
    const session = timerSession(timer);
    if (command.type !== "timer_start" && (!session || command.session_id !== timer.id)) continue;
    let next = { ...timer, revision: (BigInt(timer.revision) + 1n).toString() };
    if (command.type === "timer_start") {
      const type = command.session_type ?? "focus";
      next = { revision: next.revision, id: command.new_session_id ?? command.id, type,
        state: "active", planned_duration_seconds: plannedDurationFor(type), started_at: stamp,
        last_resumed_at: stamp, paused_at: null, remaining_seconds_at_pause: null };
    } else if (command.type === "timer_pause") {
      next = { ...next, state: "paused", paused_at: stamp,
        remaining_seconds_at_pause: remainingSeconds(session!, new Date(stamp)) };
    } else if (command.type === "timer_resume") {
      next = { ...next, state: "active", last_resumed_at: stamp, paused_at: null };
    } else {
      const type = command.type === "timer_complete" ? (timer.type === "focus" ? "break" : "focus") : timer.type;
      next = { revision: next.revision, id: command.id, type, state: "paused",
        planned_duration_seconds: plannedDurationFor(type), started_at: stamp, last_resumed_at: stamp,
        paused_at: stamp, remaining_seconds_at_pause: plannedDurationFor(type) };
    }
    timer = next;
  }
  return timer;
}
