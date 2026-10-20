import { petEventLabels } from "./types";
import type {
  DailySummary,
  PetEventRecord,
  PetEventType,
  PetSession,
  SessionRecord,
  WellnessEvent,
} from "./types";

export type DatabaseRow = Record<string, unknown>;

function text(row: DatabaseRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string")
    throw new Error(`Invalid ${key} in synced data.`);
  return value;
}

function nullableText(row: DatabaseRow, key: string): string | null {
  return row[key] == null ? null : text(row, key);
}

function integer(row: DatabaseRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`Invalid ${key} in synced data.`);
  }
  return value;
}

function choice<const T extends string>(
  row: DatabaseRow,
  key: string,
  values: readonly T[],
): T {
  const value = text(row, key);
  if (!values.includes(value as T)) throw new Error(`Unknown ${key}: ${value}`);
  return value as T;
}

export function sessionFromRow(row: DatabaseRow): SessionRecord {
  return {
    id: text(row, "id"),
    dayKey: text(row, "day_key"),
    type: choice(row, "type", ["focus", "break"]),
    plannedDurationSeconds: integer(row, "planned_duration_seconds"),
    state: choice(row, "state", ["active", "paused", "ended"]),
    outcome:
      row.outcome == null
        ? null
        : choice(row, "outcome", ["completed", "stopped"]),
    startedAt: text(row, "started_at"),
    lastResumedAt: text(row, "last_resumed_at"),
    pausedAt: nullableText(row, "paused_at"),
    endedAt: nullableText(row, "ended_at"),
    remainingSecondsAtPause:
      row.remaining_seconds_at_pause == null
        ? null
        : integer(row, "remaining_seconds_at_pause"),
  };
}

export function wellnessFromRow(row: DatabaseRow): WellnessEvent {
  return {
    id: text(row, "id"),
    dayKey: text(row, "day_key"),
    type: choice(row, "type", ["hydration", "movement"]),
    occurredAt: text(row, "occurred_at"),
  };
}

export function summaryFromRow(row: DatabaseRow): DailySummary {
  return {
    id: text(row, "id"),
    dayKey: text(row, "day_key"),
    endedFocusCount: integer(row, "ended_focus_count"),
    endedBreakCount: integer(row, "ended_break_count"),
    hydrationCount: integer(row, "hydration_count"),
    movementCount: integer(row, "movement_count"),
    lastHydrationAt: nullableText(row, "last_hydration_at"),
    hydrationTimerAnchorAt: text(row, "hydration_timer_anchor_at"),
    hydrationReminderActive: row.hydration_reminder_active === 1,
    updatedAt: text(row, "updated_at"),
  };
}

export function petSessionFromRow(row: DatabaseRow): PetSession {
  return {
    id: text(row, "id"),
    animalId: text(row, "animal_id"),
    bioName: text(row, "bio_name"),
    bioSummary: text(row, "bio_summary"),
    latestSpeech: nullableText(row, "latest_speech") ?? "",
    latestEventId: nullableText(row, "latest_event_id"),
    lastError: nullableText(row, "last_error"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

export function petEventFromRow(row: DatabaseRow): PetEventRecord {
  return {
    id: text(row, "id"),
    petSessionId: text(row, "pet_session_id"),
    eventType: choice(
      row,
      "event_type",
      Object.keys(petEventLabels) as PetEventType[],
    ),
    sourceDevice: choice(row, "source_device", [
      "macos",
      "ios",
      "badge",
      "web",
    ]),
    status: choice(row, "status", [
      "pending",
      "processing",
      "completed",
      "failed",
    ]),
    reactionSpeech: nullableText(row, "reaction_speech"),
    errorMessage: nullableText(row, "error_message"),
    createdAt: text(row, "created_at"),
    claimedAt: nullableText(row, "claimed_at"),
    completedAt: nullableText(row, "completed_at"),
  };
}
