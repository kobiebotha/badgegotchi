import { column, Schema, Table } from "@powersync/web";

// Match the existing sync streams. PowerSync supplies each table's id column.
export const AppSchema = new Schema({
  // Intentions use PowerSync's durable upload queue, never competing timer rows.
  account_commands: new Table({ payload: column.text }, { insertOnly: true }),
  pending_commands: new Table({
    payload: column.text, status: column.text, receipt: column.text,
    created_at: column.text, sequence: column.integer,
  }, { localOnly: true }),
  badge_projection: new Table({ kind: column.text, payload: column.text }),
  // Keep the old UI table so an upgrade never destroys unrelated stored data.
  ui_state: new Table({ value: column.text }, { localOnly: true }),
  sessions: new Table(
    {
      day_key: column.text,
      type: column.text,
      planned_duration_seconds: column.integer,
      state: column.text,
      outcome: column.text,
      started_at: column.text,
      last_resumed_at: column.text,
      paused_at: column.text,
      ended_at: column.text,
      remaining_seconds_at_pause: column.integer,
    },
    {
      indexes: {
        day: ["day_key"],
        state: ["state"],
        type: ["type"],
        started: ["started_at"],
      },
    },
  ),
  wellness_events: new Table(
    { day_key: column.text, type: column.text, occurred_at: column.text },
    {
      indexes: { day: ["day_key"], type: ["type"], occurred: ["occurred_at"] },
    },
  ),
  daily_activity_summary: new Table(
    {
      day_key: column.text,
      ended_focus_count: column.integer,
      ended_break_count: column.integer,
      hydration_count: column.integer,
      movement_count: column.integer,
      last_hydration_at: column.text,
      hydration_timer_anchor_at: column.text,
      hydration_reminder_active: column.integer,
      updated_at: column.text,
    },
    { indexes: { day: ["day_key"], updated: ["updated_at"] } },
  ),
  pet_sessions: new Table(
    {
      animal_id: column.text,
      bio_name: column.text,
      bio_summary: column.text,
      latest_speech: column.text,
      latest_event_id: column.text,
      last_error: column.text,
      created_at: column.text,
      updated_at: column.text,
    },
    { indexes: { updated: ["updated_at"], latest_event: ["latest_event_id"] } },
  ),
  pet_events: new Table(
    {
      pet_session_id: column.text,
      event_type: column.text,
      source_device: column.text,
      status: column.text,
      reaction_speech: column.text,
      error_message: column.text,
      created_at: column.text,
      claimed_at: column.text,
      completed_at: column.text,
    },
    {
      indexes: {
        session: ["pet_session_id"],
        status: ["status"],
        created: ["created_at"],
      },
    },
  ),
});

export type Database = (typeof AppSchema)["types"];
export type SessionRow = Database["sessions"];
export type WellnessEventRow = Database["wellness_events"];
export type DailySummaryRow = Database["daily_activity_summary"];
export type PetSessionRow = Database["pet_sessions"];
export type PetEventRow = Database["pet_events"];
