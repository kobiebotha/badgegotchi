import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { BadgePairingClient, groupedPairingCode, pairingMessage } from "../lib/badgePairing";
import type { PairedBadge, PairingCode } from "../lib/badgePairing";
import { requireConfig } from "../lib/config";
import { getSupabaseClient } from "../lib/supabase";
import "./badgePairing.css";

const POLL_INTERVAL = 3_000;
const MAX_POLLS = 100;

export function BadgePairing({ userId, onClose }: { userId: string; onClose: () => void }) {
  const api = useMemo(() => new BadgePairingClient(getSupabaseClient(), requireConfig(), userId), [userId]);
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(false);
  const epoch = useRef(0);
  const action = useRef<AbortController | null>(null);
  const polling = useRef<AbortController | null>(null);
  const activePairing = useRef<PairingCode | null>(null);
  const listSequence = useRef(0);
  const listRequest = useRef<AbortController | null>(null);
  const [pairing, setPairing] = useState<PairingCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now);
  const [pollRevision, setPollRevision] = useState(0);
  const [pollPaused, setPollPaused] = useState(false);
  const [selectedClaim, setSelectedClaim] = useState("");
  const [matched, setMatched] = useState(false);
  const [devices, setDevices] = useState<PairedBadge[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [devicesError, setDevicesError] = useState("");
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const updatePairing = useCallback((next: PairingCode | null) => {
    activePairing.current = next;
    setPairing(next);
  }, []);

  const refreshDevices = useCallback(async () => {
    const sequence = ++listSequence.current;
    listRequest.current?.abort();
    const controller = new AbortController();
    listRequest.current = controller;
    setDevicesLoading(true);
    setDevicesError("");
    try {
      const result = await api.devices(controller.signal);
      if (mounted.current && sequence === listSequence.current) setDevices(result);
    } catch (error) {
      if (mounted.current && sequence === listSequence.current && !controller.signal.aborted) setDevicesError(pairingMessage(error));
    } finally {
      if (mounted.current && sequence === listSequence.current) setDevicesLoading(false);
    }
  }, [api]);

  useEffect(() => {
    mounted.current = true;
    const element = dialog.current;
    element?.showModal();
    void refreshDevices();
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      mounted.current = false;
      ++epoch.current;
      action.current?.abort();
      polling.current?.abort();
      listRequest.current?.abort();
      element?.close();
      window.clearInterval(timer);
      const pending = activePairing.current;
      // Best effort on navigation/account changes; expiry is the fallback if
      // connectivity or the owner's session is gone. Never revoke paired badges.
      if (pending?.state === "pending") void api.cancel(pending.session_id).catch(() => undefined);
    };
  }, [api, refreshDevices]);

  const sessionId = pairing?.session_id;
  const pairingState = pairing?.state;
  useEffect(() => {
    if (!sessionId || pairingState !== "pending") return;
    const controller = new AbortController();
    polling.current = controller;
    const version = epoch.current;
    let timer: number | undefined;
    let attempts = 0;
    let failures = 0;
    setPollPaused(false);
    const current = () => mounted.current && !controller.signal.aborted && version === epoch.current;
    async function poll() {
      if (!current()) return;
      const latest = activePairing.current;
      if (!latest || Date.parse(latest.expires_at) <= Date.now()) {
        if (latest) updatePairing({ ...latest, state: "expired", code: "", claims: [] });
        return;
      }
      if (++attempts > MAX_POLLS) {
        setPollPaused(true);
        setError("Status checks paused. Check again to continue pairing.");
        return;
      }
      try {
        const status = await api.status(sessionId!, controller.signal);
        if (!current()) return;
        failures = 0;
        setError("");
        updatePairing({ ...status, code: status.state === "pending" ? latest.code : "" });
        if (status.state !== "pending") {
          if (status.state === "approved" || status.state === "delivered") void refreshDevices();
          return;
        }
      } catch (error) {
        if (!current()) return;
        if (++failures >= 3) {
          setPollPaused(true);
          setError(`${pairingMessage(error)} Automatic status checks are paused.`);
          return;
        }
      }
      if (current()) timer = window.setTimeout(() => void poll(), POLL_INTERVAL);
    }
    void poll();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [api, sessionId, pairingState, pollRevision, refreshDevices, updatePairing]);

  async function run(work: (signal: AbortSignal) => Promise<void>) {
    if (action.current) return;
    const controller = new AbortController();
    action.current = controller;
    ++epoch.current;
    polling.current?.abort();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work(controller.signal);
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) setError(pairingMessage(error));
    } finally {
      action.current = null;
      if (mounted.current) {
        setBusy(false);
        setPollRevision((value) => value + 1);
      }
    }
  }

  function generate() {
    void run(async (signal) => {
      // Creation atomically replaces any old session, including one whose
      // creation response was lost. Never reuse a possibly invalidated code.
      updatePairing(null);
      setSelectedClaim("");
      setMatched(false);
      const next = await api.create(signal);
      if (mounted.current && !signal.aborted) updatePairing(next);
    });
  }

  function cancel(close = false) {
    void run(async (signal) => {
      const pending = activePairing.current;
      const state = pending?.state === "pending" ? await api.cancel(pending.session_id, signal) : null;
      if (!mounted.current || signal.aborted) return;
      if (pending && (state === "approved" || state === "delivered")) {
        updatePairing({ ...pending, state, code: "", claims: [] });
        void refreshDevices();
        if (!close) {
          setNotice("This badge was already approved. It remains paired.");
          return;
        }
      }
      updatePairing(null);
      setMatched(false);
      setSelectedClaim("");
      if (close) {
        dialog.current?.close();
        onClose();
      }
      else setNotice("Pairing cancelled. The code can no longer be used.");
    });
  }

  const expired = pairing ? Date.parse(pairing.expires_at) <= now : false;
  const pending = pairing?.state === "pending" && !expired;
  const claims = pending ? pairing.claims.filter((claim) => claim.state === "pending") : [];
  const selected = claims.find((claim) => claim.claim_id === selectedClaim);
  const completed = pairing?.state === "approved" || pairing?.state === "delivered";
  const remaining = pairing ? Math.max(0, Math.ceil((Date.parse(pairing.expires_at) - now) / 1_000)) : 0;

  function approve() {
    if (!pairing || !selected || !matched || !pending || pollPaused) return;
    const exactSession = pairing;
    const exactClaim = selected;
    void run(async (signal) => {
      await api.approve(exactSession.session_id, exactClaim.claim_id, signal);
      if (!mounted.current || signal.aborted) return;
      updatePairing({ ...exactSession, state: "approved", code: "", claims: [] });
      setMatched(false);
      void refreshDevices();
    });
  }

  function revoke(device: PairedBadge) {
    void run(async (signal) => {
      await api.revoke(device.device_id, signal);
      if (!mounted.current || signal.aborted) return;
      setRevokeTarget(null);
      setNotice(`${device.name || "Badge"} revoked. It will need to pair again.`);
      // Refresh failure must not make a successfully revoked device appear active.
      setDevices((current) => current.map((item) => item.device_id === device.device_id
        ? { ...item, state: "revoked", revoked_at: new Date().toISOString() } : item));
      void refreshDevices();
    });
  }

  return (
    <dialog ref={dialog} className="badge-pairing-dialog" aria-labelledby="pair-badge-title" onCancel={(event) => {
      event.preventDefault();
      if (!busy) cancel(true);
    }}>
      <div className="pairing-heading">
        <div><p className="eyebrow">Take your companion with you</p><h2 id="pair-badge-title">Pair a badge</h2></div>
        <button className="icon-button" aria-label="Close badge pairing" disabled={busy} onClick={() => cancel(true)}><X size={20} /></button>
      </div>
      <p>Open Badgegotchi on your badge and enter the code with its A, B and C buttons. Pair once; it reconnects automatically next time.</p>
      {error && <p className="error-message" role="alert">{error}</p>}
      {notice && <p className="pairing-notice" role="status">{notice}</p>}
      {completed ? (
        <div className="pairing-success" role="status"><h3>Badge paired</h3><p>Keep your badge connected to Wi-Fi while it finishes signing in and syncing. It will reconnect automatically on future launches.</p></div>
      ) : pending ? (
        <section className="pairing-code-panel" aria-label="Pairing code">
          <p className="eyebrow">Enter these 12 button presses</p>
          <output className="pairing-code" aria-label={`Pairing code: ${pairing.code.split("").join(", ")}`}>{groupedPairingCode(pairing.code)}</output>
          <p className="pairing-expiry">Expires in <time>{Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}</time>. Spaces are just for readability.</p>
          {claims.length ? <>
            <h3>Check the verification ID</h3>
            <p>Select the ID that is also showing on your badge.</p>
            <fieldset className="pairing-claims"><legend>Badges waiting for approval</legend>
              {claims.map((claim) => <label key={claim.claim_id} className="pairing-claim">
                <input type="radio" name="pairing-claim" value={claim.claim_id} checked={selectedClaim === claim.claim_id} disabled={busy} onChange={() => { setSelectedClaim(claim.claim_id); setMatched(false); }} />
                <span>Verification ID <strong>{claim.verification_id}</strong></span>
              </label>)}
            </fieldset>
            {selected && <label className="pairing-match"><input type="checkbox" checked={matched} disabled={busy} onChange={(event) => setMatched(event.target.checked)} /><span>I see <strong>{selected.verification_id}</strong> on my badge.</span></label>}
            <button className="button primary" disabled={busy || !selected || !matched || pollPaused} onClick={approve}>{busy ? "Working…" : "Approve this badge"}</button>
            <p className="pairing-hint">If none match, cancel and generate a new code. Only approve your own badge.</p>
          </> : <p role="status">Waiting for your badge to enter the code…</p>}
          {pollPaused && <button className="button secondary" disabled={busy} onClick={() => setPollRevision((value) => value + 1)}>Check pairing status</button>}
        </section>
      ) : pairing ? <p role="status">{pairing.state === "revoked" ? "This badge has been revoked." : pairing.state === "cancelled" ? "This pairing was cancelled." : "This code has expired."} Generate a new code to pair.</p> : null}
      <div className="pairing-actions">
        <button className="button secondary" disabled={busy} onClick={generate}>{busy ? "Working…" : pairing ? "Generate new code" : "Generate pairing code"}</button>
        {pending && <button className="text-button" disabled={busy} onClick={() => cancel()}>Cancel pairing</button>}
      </div>
      <section className="paired-badges" aria-labelledby="paired-badges-title">
        <div className="pairing-heading"><h3 id="paired-badges-title">Your badges</h3><button className="text-button" disabled={busy || devicesLoading} onClick={() => void refreshDevices()}>Refresh badges</button></div>
        {devicesError && <p className="error-message" role="alert">{devicesError}</p>}
        {devicesLoading && <p role="status">Checking your badges…</p>}
        {!devicesLoading && !devicesError && !devices.length && <p>No badges paired yet.</p>}
        {devices.length > 0 && <ul className="paired-badge-list">{devices.map((device) => <li key={device.device_id}>
          <div><strong>{device.name || "Badge"}</strong><span>{device.state === "revoked" ? "Revoked" : "Paired"}</span>
            <small>Paired {new Date(device.paired_at).toLocaleString()}</small>
            <small>Last contact: {device.last_seen_at ? new Date(device.last_seen_at).toLocaleString() : "not recorded yet"}. This is a past check-in, not a live connection status.</small>
          </div>
          {device.state !== "revoked" && (revokeTarget === device.device_id ? <div className="pairing-revoke">
            <p>Revoke access for {device.name || "this badge"}? It must pair again. Existing sync access may take a few minutes to expire; saved data on the badge is not erased.</p>
            <button className="button secondary" disabled={busy} onClick={() => revoke(device)}>Confirm revoke</button>
            <button className="text-button" disabled={busy} onClick={() => setRevokeTarget(null)}>Keep badge</button>
          </div> : <button className="text-button" disabled={busy} onClick={() => setRevokeTarget(device.device_id)}>Revoke {device.name || "badge"}</button>)}
        </li>)}</ul>}
      </section>
      <p className="pairing-install">Need the app first? <a href="/install">Set up a badge</a>. Installation and pairing are separate steps.</p>
    </dialog>
  );
}
