import type { SessionOutcome, SessionRecord, SessionType } from "./types";

export const FOCUS_DURATION_SECONDS = 40 * 60;
export const BREAK_DURATION_SECONDS = 10 * 60;

export function plannedDurationFor(type: SessionType): number {
  return type === "focus" ? FOCUS_DURATION_SECONDS : BREAK_DURATION_SECONDS;
}

/** UTC day keys keep activity history consistent across devices. */
export function dayKeyFor(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function remainingSeconds(
  session: SessionRecord,
  now = new Date(),
): number {
  if (session.state === "ended") return 0;
  const base =
    session.remainingSecondsAtPause ?? session.plannedDurationSeconds;
  if (session.state === "paused") return Math.max(0, base);
  const elapsed = Math.max(
    0,
    Math.floor((now.getTime() - Date.parse(session.lastResumedAt)) / 1000),
  );
  return Math.max(0, base - elapsed);
}

export function pauseSession(
  session: SessionRecord,
  now = new Date(),
): SessionRecord {
  if (session.state !== "active") return session;
  return {
    ...session,
    state: "paused",
    pausedAt: now.toISOString(),
    remainingSecondsAtPause: remainingSeconds(session, now),
  };
}

export function resumeSession(
  session: SessionRecord,
  now = new Date(),
): SessionRecord {
  if (session.state !== "paused") return session;
  return {
    ...session,
    state: "active",
    lastResumedAt: now.toISOString(),
    pausedAt: null,
  };
}

export function endSession(
  session: SessionRecord,
  outcome: SessionOutcome,
  now = new Date(),
): SessionRecord {
  if (session.state === "ended") return session;
  return {
    ...session,
    state: "ended",
    outcome,
    endedAt: now.toISOString(),
    pausedAt: null,
  };
}

export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(whole / 60)
    .toString()
    .padStart(2, "0")}:${(whole % 60).toString().padStart(2, "0")}`;
}
