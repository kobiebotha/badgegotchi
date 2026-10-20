export type SessionType = "focus" | "break";
export type SessionState = "active" | "paused" | "ended";
export type SessionOutcome = "completed" | "stopped";
export type WellnessType = "hydration" | "movement";

export interface SessionRecord {
  id: string;
  dayKey: string;
  type: SessionType;
  plannedDurationSeconds: number;
  state: SessionState;
  outcome: SessionOutcome | null;
  startedAt: string;
  lastResumedAt: string;
  pausedAt: string | null;
  endedAt: string | null;
  remainingSecondsAtPause: number | null;
}

export interface WellnessEvent {
  id: string;
  dayKey: string;
  type: WellnessType;
  occurredAt: string;
}

export interface DailySummary {
  id: string;
  dayKey: string;
  endedFocusCount: number;
  endedBreakCount: number;
  hydrationCount: number;
  movementCount: number;
  lastHydrationAt: string | null;
  hydrationTimerAnchorAt: string;
  hydrationReminderActive: boolean;
  updatedAt: string;
}

export interface AnimalSpec {
  id: string;
  displayName: string;
  artAssetPath: string;
  platformAssetPath: string;
}

export interface PetSession {
  id: string;
  animalId: string;
  bioName: string;
  bioSummary: string;
  latestSpeech: string;
  latestEventId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export const petEventLabels = {
  start_focus_session: "Start focus",
  pause_focus_session: "Pause focus",
  resume_focus_session: "Resume focus",
  complete_focus_session: "Complete focus",
  stop_focus_session_early: "Stop focus early",
  start_break: "Start break",
  complete_break: "Complete break",
  stop_break_early: "Stop break early",
  pet_pet: "Pet pet",
  drink_water: "Drink water",
  move_or_stretch: "Move or stretch",
} as const;

export type PetEventType = keyof typeof petEventLabels;
export type PetEventStatus = "pending" | "processing" | "completed" | "failed";
export type PetEventSource = "macos" | "ios" | "badge" | "web";
export type SessionPhase = "idle" | "focus" | "break";

export interface PetEventRecord {
  id: string;
  petSessionId: string;
  eventType: PetEventType;
  sourceDevice: PetEventSource;
  status: PetEventStatus;
  reactionSpeech: string | null;
  errorMessage: string | null;
  createdAt: string;
  claimedAt: string | null;
  completedAt: string | null;
}

export interface BadgeSnapshot {
  activeSession: SessionRecord | null;
  sessions: SessionRecord[];
  wellnessEvents: WellnessEvent[];
  summary: DailySummary;
  pet: PetSession | null;
  activePetEvent: PetEventRecord | null;
}
