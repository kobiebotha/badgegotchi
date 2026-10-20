import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useStatus } from "@powersync/react";
import type { PowerSyncDatabase } from "@powersync/web";
import {
  Check,
  Coffee,
  Droplets,
  Footprints,
  Heart,
  Leaf,
  LogOut,
  Pause,
  Play,
  RotateCcw,
  Square,
  Timer,
  WifiOff,
  X,
} from "lucide-react";
import {
  ACTIVE_PET_EVENT_QUERY,
  ACTIVE_SESSION_QUERY,
  CURRENT_PET_QUERY,
  DAILY_SUMMARY_QUERY,
  TODAY_SESSIONS_QUERY,
  BadgeRepository,
  animalForId,
  dailySummaryParameters,
  dayKeyFor,
  formatDuration,
  pendingSpeechFor,
  petEventFromRow,
  petSessionFromRow,
  randomAnimal,
  remainingSeconds,
  sessionFromRow,
  summaryFromRow,
} from "../domain";
import type { AnimalSpec } from "../domain";
import { ensurePet, resetPet } from "../lib/petCloud";
import { signOut } from "../lib/database";
import { messageFor } from "../lib/errors";
import { Brand } from "./Brand";
import { BadgePairing } from "./BadgePairing";

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = () => setNow(new Date());
    const timer = window.setInterval(tick, 1000);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
    };
  }, []);
  return now;
}

export function Dashboard({
  db,
  userId,
  email,
}: {
  db: PowerSyncDatabase;
  userId: string;
  email: string;
}) {
  const repository = useMemo(
    () => new BadgeRepository(db, userId),
    [db, userId],
  );
  const now = useClock();
  const day = dayKeyFor(now);
  const openedAt = useMemo(() => new Date(), [day]);
  const status = useStatus();
  const activeQuery = useQuery(ACTIVE_SESSION_QUERY);
  const petQuery = useQuery(CURRENT_PET_QUERY);
  const eventQuery = useQuery(ACTIVE_PET_EVENT_QUERY);
  const sessionsQuery = useQuery(TODAY_SESSIONS_QUERY, [day]);
  const summaryQuery = useQuery(
    DAILY_SUMMARY_QUERY,
    dailySummaryParameters(day, userId, openedAt),
  );
  const completionQuery = useQuery<{ value: string }>(
    "SELECT value FROM ui_state WHERE id = 'dismissed_completion'",
  );
  const active = activeQuery.data[0]
    ? sessionFromRow(activeQuery.data[0])
    : null;
  const pet = petQuery.data[0] ? petSessionFromRow(petQuery.data[0]) : null;
  const petEvent = eventQuery.data[0]
    ? petEventFromRow(eventQuery.data[0])
    : null;
  const summary = summaryQuery.data[0]
    ? summaryFromRow(summaryQuery.data[0])
    : null;
  const latest = sessionsQuery.data[0]
    ? sessionFromRow(sessionsQuery.data[0])
    : null;
  const dismissedCompletion = completionQuery.data[0]?.value;
  const completion =
    !completionQuery.isLoading &&
    !active &&
    latest?.state === "ended" &&
    latest.outcome === "completed" &&
    latest.id !== dismissedCompletion
      ? latest
      : null;
  const remaining = active
    ? remainingSeconds(active, now)
    : completion
      ? 0
      : 40 * 60;
  const isBreak = active?.type === "break" || completion?.type === "break";
  const progress = active
    ? 1 - remaining / active.plannedDurationSeconds
    : completion
      ? 1
      : 0;
  const [busy, setBusy] = useState(false);
  const actionInFlight = useRef(false);
  const [error, setError] = useState("");
  const [petError, setPetError] = useState("");
  const [petBusy, setPetBusy] = useState(false);
  const petRequestInFlight = useRef(false);
  const [notice, setNotice] = useState("");
  const [dialog, setDialog] = useState<"reset" | "signout" | null>(null);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [pendingUploads, setPendingUploads] = useState(0);
  const resetRequest = useRef<{ id: string; animal: AnimalSpec } | null>(null);
  const initialPetRequested = useRef(false);
  const animal = pet ? animalForId(pet.animalId) : null;

  const runAction = useCallback(
    async (action: () => Promise<unknown>, noticeText?: string) => {
      if (actionInFlight.current) return;
      actionInFlight.current = true;
      setBusy(true);
      setError("");
      try {
        await action();
        if (noticeText) setNotice(noticeText);
      } catch (error) {
        setError(messageFor(error));
      } finally {
        actionInFlight.current = false;
        setBusy(false);
      }
    },
    [],
  );

  const initializePet = useCallback(async () => {
    if (petRequestInFlight.current) return;
    petRequestInFlight.current = true;
    setPetBusy(true);
    setPetError("");
    try {
      await ensurePet(randomAnimal(), userId);
    } catch (error) {
      setPetError(messageFor(error));
    } finally {
      petRequestInFlight.current = false;
      setPetBusy(false);
    }
  }, [userId]);

  useEffect(() => {
    if (petQuery.isLoading || pet || initialPetRequested.current) return;
    initialPetRequested.current = true;
    void initializePet();
  }, [petQuery.isLoading, pet, initializePet]);

  useEffect(() => {
    if (pet?.id) setPetError("");
  }, [pet?.id]);

  useEffect(() => {
    if (!active || active.state !== "active" || remaining > 0 || error || busy)
      return;
    void runAction(() => repository.completeExpiredSession(active.id));
  }, [
    active?.id,
    active?.state,
    remaining,
    repository,
    runAction,
    error,
    busy,
  ]);

  useEffect(() => {
    document.title = active
      ? `${formatDuration(remaining)} · ${isBreak ? "Break" : "Focus"} · Badgegotchi`
      : "Badgegotchi — a little focus, a little care";
    return () => {
      document.title = "Badgegotchi — a little focus, a little care";
    };
  }, [active?.id, remaining, isBreak]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const queryError =
    activeQuery.error ||
    petQuery.error ||
    eventQuery.error ||
    summaryQuery.error ||
    sessionsQuery.error ||
    completionQuery.error;
  const syncError =
    status.dataFlowStatus.uploadError || status.dataFlowStatus.downloadError;
  const loading =
    activeQuery.isLoading ||
    summaryQuery.isLoading ||
    completionQuery.isLoading;
  const timerLabel = active
    ? `${isBreak ? "Break" : "Focus"} ${active.state === "paused" ? "paused" : "session"}`
    : completion
      ? `${isBreak ? "Break" : "Focus"} complete`
      : "Time to focus";
  const speech = petEvent
    ? pendingSpeechFor(petEvent.eventType) === "…"
      ? "One little moment…"
      : pendingSpeechFor(petEvent.eventType)
    : pet?.latestSpeech ||
      pet?.bioSummary ||
      (petError
        ? "Your timer is ready. Your companion will join when we reconnect."
        : "Making a little room for your companion…");
  const statusLabel = syncError
    ? "Sync needs attention"
    : status.connected
      ? status.dataFlowStatus.uploading || status.dataFlowStatus.downloading
        ? "Syncing changes"
        : "All connected"
      : status.connecting
        ? "Connecting"
        : "Working offline";

  async function requestSignOut() {
    await runAction(async () => {
      const stats = await db.getUploadQueueStats();
      if (stats.count > 0) {
        setPendingUploads(stats.count);
        setDialog("signout");
      } else {
        await signOut();
      }
    });
  }

  function dismissCompletion(id: string) {
    void runAction(() =>
      db.execute(
        "INSERT OR REPLACE INTO ui_state (id, value) VALUES ('dismissed_completion', ?)",
        [id],
      ),
    );
  }

  async function resetToday() {
    if (petRequestInFlight.current) return;
    petRequestInFlight.current = true;
    setPetBusy(true);
    setPetError("");
    // Retain the command and animal if the request times out so retries cannot
    // create another pet. Cloud owns the replacement; sync delivers its state.
    resetRequest.current ??= {
      id: crypto.randomUUID(),
      animal: randomAnimal(),
    };
    try {
      await resetPet(
        resetRequest.current.animal,
        resetRequest.current.id,
        userId,
      );
      await repository.resetDay(day);
      resetRequest.current = null;
      setDialog(null);
      setNotice("A fresh start. Make yourself at home.");
    } catch (error) {
      setPetError(messageFor(error));
    } finally {
      petRequestInFlight.current = false;
      setPetBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <Brand />
        <div className="header-actions">
          <button className="installer-nav pairing-nav" onClick={() => setPairingOpen(true)}>Pair a badge</button>
          <a className="installer-nav" href="/install">Set up a badge</a>
          <span
            className={`sync-status ${syncError ? "has-error" : ""}`}
            title={
              status.lastSyncedAt
                ? `Last synced ${status.lastSyncedAt.toLocaleTimeString()}`
                : undefined
            }
          >
            {status.connected ? (
              <span className="status-dot" />
            ) : (
              <WifiOff size={14} />
            )}
            {statusLabel}
          </span>
          <button
            className="icon-button"
            aria-label="Sign out"
            title={`Sign out ${email}`}
            onClick={() => void requestSignOut()}
            disabled={busy}
          >
            <LogOut size={18} />
          </button>
        </div>
      </header>
      <main>
        <div className="page-heading">
          <div>
            <p className="eyebrow">Your daily little ritual</p>
            <h1>Let’s find your rhythm.</h1>
          </div>
          <p className="today-date">
            {now.toLocaleDateString(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
              timeZone: "UTC",
            })}
            <span>One good moment at a time.</span>
          </p>
        </div>
        {(error || queryError) && (
          <div className="error-message" role="alert">
            {error || messageFor(queryError)}{" "}
            <button className="text-button" onClick={() => setError("")}>
              Dismiss
            </button>
          </div>
        )}
        {syncError && (
          <div className="sync-banner" role="status">
            Your changes are saved on this device. Sync will retry
            automatically.{" "}
            <details>
              <summary>Connection details</summary>
              {messageFor(syncError)}
            </details>
          </div>
        )}
        <div className="workspace-grid">
          <section
            className="companion-panel panel"
            aria-labelledby="companion-title"
          >
            <div className="panel-heading">
              <div>
                <p className="eyebrow">In your corner</p>
                <h2 id="companion-title">
                  {pet?.bioName || "Your little companion"}
                </h2>
              </div>
              <span className="pill soft">
                {animal?.displayName || "Settling in"}
              </span>
            </div>
            <div className="speech-bubble" role="status">
              <p>{speech}</p>
              {petEvent && (
                <span className="thinking-label">
                  {status.connected
                    ? "Thinking of a reply"
                    : "Reply queued for when you’re online"}
                  <span className="thinking-dots">…</span>
                </span>
              )}
            </div>
            <div
              className={`pet-stage ${petEvent?.eventType === "pet_pet" ? "is-petted" : ""}`}
            >
              <div className="stage-halo" />
              {animal ? (
                <img
                  className="pet-art"
                  src={animal.artAssetPath}
                  alt={`${pet?.bioName}, your ${animal.displayName.toLowerCase()} companion`}
                />
              ) : (
                <img
                  className="pet-placeholder"
                  src="/assets/icons/capybara-icon-64.png"
                  alt=""
                />
              )}
              <button
                className="pet-button"
                disabled={!pet || Boolean(petEvent) || petBusy || busy}
                onClick={() =>
                  void runAction(
                    () => repository.enqueuePetEvent("pet_pet"),
                    "A little love goes a long way.",
                  )
                }
              >
                <Heart size={19} />
                Pet {pet?.bioName || "your companion"}
              </button>
            </div>
            {(petError || pet?.lastError) && (
              <div className="pet-error" role="alert">
                <p>{petError || pet?.lastError}</p>
                {!pet && (
                  <button
                    className="text-button"
                    disabled={petBusy}
                    onClick={() => void initializePet()}
                  >
                    Try connecting your pet again
                  </button>
                )}
              </div>
            )}
            <p className="companion-caption">
              <Heart size={13} /> A little company makes a difference.
            </p>
          </section>
          <div className="routine-column">
            <section
              className={`timer-panel panel ${isBreak ? "break-mode" : ""}`}
              aria-labelledby="timer-title"
            >
              <div className="panel-heading">
                <h2 id="timer-title">
                  {isBreak ? <Coffee size={19} /> : <Timer size={19} />}
                  {timerLabel}
                </h2>
                <span className="eyebrow">
                  {isBreak ? "Rest & recharge" : "One thing at a time"}
                </span>
              </div>
              <div
                className="timer-digits"
                role="timer"
                aria-label={`${Math.floor(remaining / 60)} minutes ${remaining % 60} seconds remaining`}
              >
                {formatDuration(remaining)}
              </div>
              <div
                className="progress-track"
                role="progressbar"
                aria-label="Session progress"
                aria-valuenow={Math.round(progress * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div style={{ width: `${progress * 100}%` }} />
              </div>
              <p className="timer-hint">
                {active?.state === "paused"
                  ? "Take your time. We’ll be right here."
                  : completion
                    ? "That’s a little win. Take a breath."
                    : isBreak
                      ? "Stretch, look away, and let your mind wander."
                      : "A quiet pocket of time for what matters."}
              </p>
              <div className="timer-actions">
                {active ? (
                  <>
                    <button
                      className="button primary"
                      disabled={busy || loading}
                      onClick={() =>
                        void runAction(() =>
                          active.state === "paused"
                            ? repository.resumeSession(active.id)
                            : repository.pauseSession(active.id),
                        )
                      }
                    >
                      {active.state === "paused" ? (
                        <Play size={17} fill="currentColor" />
                      ) : (
                        <Pause size={17} />
                      )}
                      {active.state === "paused" ? "Resume" : "Pause"}
                    </button>
                    <button
                      className="button secondary"
                      disabled={busy || loading}
                      onClick={() =>
                        void runAction(() =>
                          repository.endSession(active.id, "stopped"),
                        )
                      }
                    >
                      <Square size={15} />
                      Stop
                    </button>
                  </>
                ) : completion ? (
                  <>
                    <button
                      className="button primary"
                      disabled={busy || loading}
                      onClick={() =>
                        completion.type === "focus"
                          ? void runAction(() =>
                              repository.startSession("break"),
                            )
                          : dismissCompletion(completion.id)
                      }
                    >
                      {completion.type === "focus" ? (
                        <Coffee size={17} />
                      ) : (
                        <Check size={17} />
                      )}
                      {completion.type === "focus"
                        ? "Start a 10 min break"
                        : "Back to focus"}
                    </button>
                    {completion.type === "focus" && (
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() => dismissCompletion(completion.id)}
                      >
                        Skip break
                      </button>
                    )}
                  </>
                ) : (
                  <button
                    className="button primary full"
                    disabled={busy || loading}
                    onClick={() =>
                      void runAction(() => repository.startSession("focus"))
                    }
                  >
                    <Play size={17} fill="currentColor" />
                    {loading ? "Restoring your timer…" : "Start focus"}
                  </button>
                )}
              </div>
              <div className="timer-footnote">
                <span>40 min focus</span>
                <span className="tiny-separator" />
                <span>10 min break</span>
              </div>
            </section>
            <section
              className="wellness-panel panel"
              aria-labelledby="wellness-title"
            >
              <div className="panel-heading">
                <h2 id="wellness-title">
                  <Leaf size={19} />A moment for you
                </h2>
              </div>
              <p>Small check-ins. A better-feeling day.</p>
              <div className="wellness-actions">
                <button
                  disabled={busy || loading}
                  onClick={() =>
                    void runAction(
                      () => repository.logWellness("hydration"),
                      "Water logged. A little refresh.",
                    )
                  }
                >
                  <span className="wellness-icon water">
                    <Droplets size={23} />
                  </span>
                  <span>
                    Drink water<small>Log a glass</small>
                  </span>
                  <span className="action-plus">+</span>
                </button>
                <button
                  disabled={busy || loading}
                  onClick={() =>
                    void runAction(
                      () => repository.logWellness("movement"),
                      "Movement logged. A good stretch.",
                    )
                  }
                >
                  <span className="wellness-icon movement">
                    <Footprints size={23} />
                  </span>
                  <span>
                    Move & stretch<small>Take a little reset</small>
                  </span>
                  <span className="action-plus">+</span>
                </button>
              </div>
            </section>
          </div>
        </div>
        <section className="daily-panel panel" aria-labelledby="daily-title">
          <div className="daily-heading">
            <h2 id="daily-title">Today’s little wins</h2>
            <p>Every bit counts.</p>
          </div>
          <div className="daily-stats">
            <Metric
              icon={<Timer size={19} />}
              value={summary?.endedFocusCount ?? 0}
              label="Focus ended"
            />
            <Metric
              icon={<Coffee size={19} />}
              value={summary?.endedBreakCount ?? 0}
              label="Breaks ended"
            />
            <Metric
              icon={<Droplets size={19} />}
              value={summary?.hydrationCount ?? 0}
              label="Glasses of water"
            />
            <Metric
              icon={<Footprints size={19} />}
              value={summary?.movementCount ?? 0}
              label="Movement breaks"
            />
          </div>
        </section>
        <div className="below-workspace">
          <span>
            Progress follows you across your devices. Daily totals use UTC.
          </span>
          <button
            className="text-button"
            disabled={busy || petBusy}
            onClick={() => setDialog("reset")}
          >
            <RotateCcw size={13} />
            Start fresh
          </button>
        </div>
      </main>
      <footer className="site-footer">
        <span>A kinder kind of productivity.</span>
        <span>Made with PowerSync</span>
      </footer>
      <div className={`toast ${notice ? "visible" : ""}`} role="status">
        {notice && (
          <>
            <Check size={16} />
            {notice}
          </>
        )}
      </div>
      {pairingOpen && <BadgePairing userId={userId} onClose={() => setPairingOpen(false)} />}
      {dialog && (
        <ConfirmDialog
          title={
            dialog === "reset" ? "A fresh start?" : "You have unsynced changes"
          }
          busy={busy || petBusy}
          onCancel={() => setDialog(null)}
          onConfirm={() =>
            dialog === "reset" ? void resetToday() : void runAction(signOut)
          }
          confirmLabel={
            dialog === "reset"
              ? "Reset today & meet a new pet"
              : "Discard changes & sign out"
          }
        >
          <p>
            {dialog === "reset"
              ? "This clears today’s focus and wellness records across your devices and brings in a new companion. Earlier days stay in your history. You’ll need a connection to continue."
              : `${pendingUploads} changes are still waiting to upload. Signing out removes this device’s local data. Stay here and reconnect to keep those changes.`}
          </p>
          {petError && dialog === "reset" && (
            <p className="error-message" role="alert">
              {petError}
            </p>
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}

function Metric({
  icon,
  value,
  label,
}: {
  icon: React.ReactNode;
  value: number;
  label: string;
}) {
  return (
    <div className="metric">
      <span className="metric-icon">{icon}</span>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function ConfirmDialog({
  title,
  children,
  busy,
  onCancel,
  onConfirm,
  confirmLabel,
}: {
  title: string;
  children: React.ReactNode;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  confirmLabel: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="confirm-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <button
        className="icon-button dialog-close"
        aria-label="Close dialog"
        disabled={busy}
        onClick={onCancel}
      >
        <X size={20} />
      </button>
      <h2>{title}</h2>
      {children}
      <div className="dialog-actions">
        <button
          className="button secondary"
          disabled={busy}
          onClick={onCancel}
          autoFocus
        >
          Keep going
        </button>
        <button className="button primary" disabled={busy} onClick={onConfirm}>
          {busy ? "Working…" : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
