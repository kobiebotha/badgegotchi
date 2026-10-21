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
  CURRENT_PET_QUERY,
  BadgeRepository,
  ACCOUNT_PROJECTION_QUERY,
  PENDING_COMMANDS_QUERY,
  accountProjection,
  accountPetIsThinking,
  pendingCommandFromRow,
  replayTimer,
  timerSession,
  animalForId,
  dayKeyFor,
  formatDuration,
  pendingSpeechFor,
  petEventFromRow,
  petSessionFromRow,
  randomAnimal,
  remainingSeconds,
} from "../domain";
import type { AnimalSpec } from "../domain";
import { ensurePet, resetPet } from "../lib/petCloud";
import { refreshAccountProjection } from "../lib/backend";
import { requireConfig } from "../lib/config";
import { getSupabaseClient } from "../lib/supabase";
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
  const status = useStatus();
  const projectionQuery = useQuery(ACCOUNT_PROJECTION_QUERY);
  const pendingQuery = useQuery(PENDING_COMMANDS_QUERY);
  const petQuery = useQuery(CURRENT_PET_QUERY);
  const eventQuery = useQuery(ACTIVE_PET_EVENT_QUERY);
  const projection = accountProjection(projectionQuery.data);
  const pending = pendingQuery.data.map(pendingCommandFromRow);
  const queued = pending.filter((item) => item.status !== "rejected");
  const rejected = pending.filter((item) => item.status === "rejected");
  const timer = projection.timer ? replayTimer(projection.timer, pending) : null;
  const active = timer ? timerSession(timer) : null;
  const pet = petQuery.data[0] ? petSessionFromRow(petQuery.data[0]) : null;
  const petEvent = eventQuery.data[0] ? petEventFromRow(eventQuery.data[0]) : null;
  const petThinking = accountPetIsThinking(projection.pet);
  const summary = projection.totals;
  const remaining = active ? remainingSeconds(active, now) : 40 * 60;
  const isBreak = active?.type === "break";
  const ready = active?.state === "paused" && remaining === active.plannedDurationSeconds;
  const progress = active ? 1 - remaining / active.plannedDurationSeconds : 0;
  const completionRejected = rejected.some((item) =>
    item.command.type === "timer_complete" && item.command.expected_revision === timer?.revision);
  const timerPending = queued.some((item) => item.command.type.startsWith("timer_"));
  const petPending = queued.some((item) => item.command.type === "pet");
  const projectionKey = JSON.stringify(projectionQuery.data);
  const pendingKey = JSON.stringify(pendingQuery.data);
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
    void refreshAccountProjection(getSupabaseClient(), requireConfig(), userId).catch(() => {
      // Cached account state and durable queued actions remain available offline.
    });
  }, [userId, day, status.connected]);

  useEffect(() => {
    void repository.reconcileConfirmed().catch((cause) => setError(messageFor(cause)));
  }, [repository, projectionKey, pendingKey, status.lastSyncedAt?.getTime()]);

  useEffect(() => {
    if (petQuery.isLoading || pet || initialPetRequested.current) return;
    initialPetRequested.current = true;
    void initializePet();
  }, [petQuery.isLoading, pet, initializePet]);

  useEffect(() => {
    if (pet?.id) setPetError("");
  }, [pet?.id]);

  useEffect(() => {
    if (!active || active.state !== "active" || remaining > 0 || error || busy || completionRejected)
      return;
    void runAction(() => repository.completeExpiredSession(active.id));
  }, [
    active?.id,
    active?.state,
    completionRejected,
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

  const queryError = projectionQuery.error || pendingQuery.error || petQuery.error || eventQuery.error;
  const syncError = status.dataFlowStatus.uploadError || status.dataFlowStatus.downloadError;
  const loading = projectionQuery.isLoading || pendingQuery.isLoading || !timer;
  const timerLabel = active
    ? `${isBreak ? "Break" : "Focus"} ${ready ? "ready" : active.state === "paused" ? "paused" : "session"}`
    : "Time to focus";
  const speech = petThinking
    ? !petEvent || pendingSpeechFor(petEvent.eventType) === "…"
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

  async function resetToday() {
    if (petRequestInFlight.current || queued.length) return;
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
            Your actions are queued for your account. Sync will retry
            automatically.{" "}
            <details>
              <summary>Connection details</summary>
              {messageFor(syncError)}
            </details>
          </div>
        )}
        {queued.length > 0 && <div className="sync-banner" role="status">
          {queued.length} account {queued.length === 1 ? "action" : "actions"} pending sync.
          Daily totals show confirmed account activity.
        </div>}
        {rejected.length > 0 && <div className="error-message" role="alert">
          {rejected.length} {rejected.length === 1 ? "action could" : "actions could"} not be applied because your account changed on another device.
          Your latest account state is shown. Try the action again if you still want it.
          <button className="text-button" onClick={() => void runAction(() => repository.dismissRejections())}>Dismiss</button>
        </div>}
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
              {petThinking && (
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
                disabled={!pet || petThinking || petPending || petBusy || busy}
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
                  : isBreak
                      ? "Stretch, look away, and let your mind wander."
                      : "A quiet pocket of time for what matters."}
              </p>
              {timerPending && <p className="timer-hint" role="status">Timer change pending sync</p>}
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
                      {active.state === "paused" ? ready ? `Start ${isBreak ? "break" : "focus"}` : "Resume" : "Pause"}
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
            <h2 id="daily-title">{summary?.day_key === day ? "Today’s little wins" : "Last synced account activity"}</h2>
            <p>{summary ? `${summary.day_key} · UTC${summary.day_key === day ? "" : " · reconnect to refresh"}` : "Waiting for account totals…"}</p>
          </div>
          <div className="daily-stats">
            <Metric
              icon={<Timer size={19} />}
              value={summary?.ended_focus_count ?? "—"}
              label="Focus ended"
            />
            <Metric
              icon={<Coffee size={19} />}
              value={summary?.ended_break_count ?? "—"}
              label="Breaks ended"
            />
            <Metric
              icon={<Droplets size={19} />}
              value={summary?.hydration_count ?? "—"}
              label="Glasses of water"
            />
            <Metric
              icon={<Footprints size={19} />}
              value={summary?.movement_count ?? "—"}
              label="Movement breaks"
            />
            <Metric icon={<Heart size={19} />} value={summary?.pet_count ?? "—"} label="Pet moments" />
          </div>
        </section>
        <div className="below-workspace">
          <span>
            Your badge and web share one account. Daily totals are confirmed activity in UTC.
          </span>
          <button
            className="text-button"
            disabled={busy || petBusy || queued.length > 0 || !status.connected}
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
  value: number | string;
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
