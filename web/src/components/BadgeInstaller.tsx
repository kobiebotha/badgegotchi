import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Cable, CheckCircle2, Download, FolderOpen, Info, LoaderCircle, RefreshCw, ShieldCheck, Usb } from "lucide-react";
import { Brand } from "./Brand";
import { loadAppRelease, prepareApp, type PreparedApp } from "../installer/appRelease";
import { chooseBadgeDrive, copyApp, supportsAppCopy, validateBadgeDrive, type AppDirectoryHandle, type CopyProgress } from "../installer/appCopy";
import "./installer.css";

type ReleaseState = "loading" | "unpublished" | "checking" | "ready" | "error";

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") return "No drive was selected. Choose the Badgeware drive when you’re ready.";
    if (error.name === "SecurityError" || error.name === "NotAllowedError") {
      return "The browser couldn’t access that folder. Allow access to the Badgeware drive, or use the ZIP download below.";
    }
    return error.message;
  }
  return "The drive couldn’t be reached. Reconnect your badge and try again.";
}

export function BadgeInstaller() {
  const [prepared, setPrepared] = useState<PreparedApp | null>(null);
  const [releaseState, setReleaseState] = useState<ReleaseState>("loading");
  const [releaseError, setReleaseError] = useState("");
  const [reload, setReload] = useState(0);
  const [drive, setDrive] = useState<AppDirectoryHandle | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [copying, setCopying] = useState(false);
  const [complete, setComplete] = useState(false);
  const [progress, setProgress] = useState<CopyProgress | null>(null);
  const [installError, setInstallError] = useState("");
  const [downloadNotice, setDownloadNotice] = useState("");
  const [copySupported] = useState(supportsAppCopy);
  const operationRef = useRef<"choosing" | "copying" | null>(null);
  const mountedRef = useRef(false);
  const busy = choosing || copying;
  const ready = releaseState === "ready" && prepared !== null;

  useEffect(() => {
    mountedRef.current = true;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (operationRef.current !== "copying") return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      mountedRef.current = false;
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setReleaseState("loading");
    setReleaseError("");
    setPrepared(null);
    void (async () => {
      try {
        const release = await loadAppRelease(controller.signal);
        if (!current) return;
        if (!release) { setReleaseState("unpublished"); return; }
        setReleaseState("checking");
        const next = await prepareApp(release, controller.signal);
        if (!current) return;
        setPrepared(next);
        setReleaseState("ready");
      } catch (error) {
        if (!current) return;
        setReleaseState("error");
        setReleaseError(errorMessage(error));
      }
    })();
    return () => { current = false; controller.abort(); };
  }, [reload]);

  async function chooseDrive() {
    if (operationRef.current || !ready || !copySupported) return;
    operationRef.current = "choosing";
    setChoosing(true);
    setInstallError("");
    setComplete(false);
    setDrive(null);
    try {
      const next = await chooseBadgeDrive();
      await validateBadgeDrive(next);
      if (mountedRef.current) setDrive(next);
    } catch (error) {
      if (mountedRef.current) setInstallError(errorMessage(error));
    } finally {
      operationRef.current = null;
      if (mountedRef.current) setChoosing(false);
    }
  }

  async function install() {
    if (operationRef.current || !drive || !prepared) return;
    operationRef.current = "copying";
    setCopying(true);
    setComplete(false);
    setInstallError("");
    setProgress({ completed: 0, total: prepared.files.length, path: "" });
    try {
      await copyApp(drive, prepared, (next) => { if (mountedRef.current) setProgress(next); });
      if (mountedRef.current) setComplete(true);
    } catch (error) {
      if (mountedRef.current) setInstallError(errorMessage(error));
    } finally {
      operationRef.current = null;
      if (mountedRef.current) { setDrive(null); setCopying(false); }
    }
  }

  function saveZip() {
    if (!prepared || busy) return;
    const url = URL.createObjectURL(new Blob([new Uint8Array(prepared.zip)], { type: "application/zip" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `badgegotchi-${prepared.release.version}.zip`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    setDownloadNotice("App ZIP download started. Follow the copy steps below, then safely eject the drive.");
  }

  return (
    <div className="landing installer-page">
      <header className="site-header" onClickCapture={(event) => {
        if (copying && (event.target as Element).closest("a")) event.preventDefault();
      }}>
        <Brand />
        <a className="installer-home-link" href="/" aria-disabled={copying || undefined} tabIndex={copying ? -1 : undefined}>
          <ArrowLeft size={15} /> Back to your companion
        </a>
      </header>
      <main className="installer-main">
        <section className="installer-intro" aria-labelledby="installer-title">
          <div>
            <span className="pill"><Usb size={14} aria-hidden="true" /> A Badgeware app for Tufty 2350</span>
            <h1 id="installer-title">A little friend.<br />Ready to come along.</h1>
            <p>Add Badgegotchi to your badge’s launcher. Connect your Tufty 2350 with a USB data cable, then copy the app to its Badgeware drive.</p>
            <span className="installer-intro-note"><ShieldCheck size={15} aria-hidden="true" /> Your Badgeware firmware, apps, and data stay in place.</span>
          </div>
          <div className="installer-badge-scene" aria-hidden="true">
            <span className="installer-floating-note">One more friend in your launcher</span>
            <div className="installer-badge">
              <span className="installer-badge-slot" />
              <div className="installer-badge-screen">
                <span>badgegotchi.</span><img src="/assets/animals/capybara.png" alt="" />
                <span className="installer-badge-caption">One little step at a time.</span>
              </div>
              <div className="installer-badge-buttons"><i /><i /><i /></div>
            </div>
            <span className="installer-cable" />
          </div>
        </section>
        <ol className="installer-overview" aria-label="Installation steps">
          <li><span>1</span><div>Open the file drive<small>Double-tap RESET on your badge</small></div></li>
          <li><span>2</span><div>Copy the app<small>Use the browser or download the ZIP</small></div></li>
          <li><span>3</span><div>Meet your companion<small>Eject, reset, and open Badgegotchi</small></div></li>
        </ol>
        <div className="installer-workspace">
          <section className="installer-setup panel" aria-labelledby="prepare-title">
            <div className="installer-section-heading">
              <span className="installer-icon-tile"><Cable size={22} aria-hidden="true" /></span>
              <div><p className="eyebrow">Before you copy</p><h2 id="prepare-title">Get your badge ready</h2></div>
            </div>
            <ol className="installer-instructions">
              <li>Connect your <strong>Pimoroni Tufty 2350</strong> with its normal Badgeware launcher running.</li>
              <li>Double-tap <kbd>RESET</kbd> to open the Badgeware USB file drive.</li>
              <li>Open that drive on your computer. It should contain an <strong>apps</strong> folder.</li>
              <li>Keep the badge connected while the app copies. Safely eject the drive when copying finishes, then press <kbd>RESET</kbd> once.</li>
            </ol>
            <p className="installer-setup-tip">If the drive is called RP2350 or contains INFO_UF2.TXT, press RESET once and try the double-tap again. That is the firmware boot drive.</p>
            <div className="installer-alpha-note">
              <Info size={19} aria-hidden="true" />
              <div><strong>Local companion alpha</strong><p>This version stores progress on your badge. Cloud sync, account pairing, and AI conversations are not available yet.</p></div>
            </div>
            <p className="installer-compatibility">Qualified on Tufty 2350 with Badgeware <code>bw-1.29.0-gc</code>. The app checks its native runtime compatibility when it opens.</p>
          </section>
          <section className="installer-action panel" aria-labelledby="install-title" aria-busy={busy || releaseState === "loading" || releaseState === "checking"}>
            <div className="installer-section-heading">
              <span className="installer-icon-tile"><FolderOpen size={22} aria-hidden="true" /></span>
              <div><p className="eyebrow">Add to your launcher</p><h2 id="install-title">Install Badgegotchi</h2></div>
            </div>
            {releaseState === "unpublished" ? (
              <div className="installer-release-pending"><h3>The app is being prepared</h3><p>A verified app package will appear here when it is ready.</p></div>
            ) : releaseState === "loading" || releaseState === "checking" ? (
              <div className="installer-loading" role="status"><LoaderCircle className="installer-spin" size={25} aria-hidden="true" />
                <h3>{releaseState === "loading" ? "Checking for the app…" : "Verifying the app files…"}</h3><p>Every file is checked before copying is available.</p>
              </div>
            ) : releaseState === "error" ? (
              <div className="installer-release-error"><h3>The app couldn’t be verified</h3><p role="alert">{releaseError}</p>
                <button className="button secondary" onClick={() => setReload((value) => value + 1)}><RefreshCw size={16} aria-hidden="true" /> Try again</button>
              </div>
            ) : (
              <>
                <div className="installer-release-summary"><ShieldCheck size={22} aria-hidden="true" />
                  <div><strong>Badgegotchi · Local alpha</strong><span>Version {prepared?.release.version} · Download verified</span></div>
                </div>
                <p className="installer-release-description">{prepared?.release.description}</p>
                {complete ? (
                  <div className="installer-success" role="status"><CheckCircle2 size={35} aria-hidden="true" /><h3>App copied and verified</h3>
                    <p>Safely eject the Badgeware drive, press RESET once, then open Badgegotchi in the launcher.</p>
                  </div>
                ) : copying ? (
                  <div className="installer-progress" role="status">
                    <div className="installer-progress-heading"><LoaderCircle className="installer-spin" size={19} aria-hidden="true" /> Copying and checking app files…</div>
                    <progress aria-label="App files copied and verified" value={progress?.completed ?? 0} max={progress?.total ?? 1} />
                    <p>{progress?.completed ?? 0} of {progress?.total ?? 0} files verified</p>
                    <p className="installer-stay-connected">Keep the badge connected and this page open until copying finishes.</p>
                  </div>
                ) : copySupported ? (
                  <div className="installer-connect">
                    {drive ? <><p className="installer-selected-drive">Selected drive: <strong>{drive.name}</strong></p>
                      <button className="button primary full" onClick={() => void install()}><FolderOpen size={17} aria-hidden="true" /> Copy app to badge</button>
                      <button className="text-button" onClick={() => void chooseDrive()}>Choose another drive</button>
                    </> : <button className="button primary full" disabled={choosing} onClick={() => void chooseDrive()}>
                      {choosing ? <LoaderCircle className="installer-spin" size={17} aria-hidden="true" /> : <FolderOpen size={17} aria-hidden="true" />}
                      {choosing ? "Checking the drive…" : "Choose Badgeware drive"}
                    </button>}
                    <p className="installer-small-note">Choose the drive itself, containing the apps folder. This adds a new apps/badgegotchi folder and stops if one already exists.</p>
                  </div>
                ) : <div className="installer-browser-note"><h3>Install with the ZIP download</h3><p>This browser can download the app. Use your computer’s file manager to copy it to the badge.</p></div>}
              </>
            )}
            {installError ? <p className="installer-error" role="alert">{installError}</p> : null}
            <div className="installer-manual">
              <h3>Copy with your file manager</h3>
              <button className="button secondary full" disabled={!ready || busy} onClick={saveZip}><Download size={17} aria-hidden="true" /> Download verified app ZIP</button>
              <ol>
                <li>Extract the ZIP on your computer.</li>
                <li>Open the extracted <code>apps</code> folder. Copy only its <code>badgegotchi</code> folder into the Badgeware drive’s <code>apps</code> folder. If Badgegotchi is already there, stop and keep the existing folder.</li>
                <li>Wait for the copy to finish, safely eject the drive, and press RESET once.</li>
                <li>Choose <strong>Badgegotchi</strong> in the launcher.</li>
              </ol>
              {downloadNotice ? <p role="status">{downloadNotice}</p> : null}
            </div>
          </section>
        </div>
        <aside className="installer-recovery"><Info size={22} aria-hidden="true" /><div><h2>Already have Badgegotchi?</h2>
          <p>This first installer adds a new app only. Keep your existing app and saved progress; an update flow will be provided separately. The download does not set up Wi-Fi or connect this badge to your web account.</p>
        </div></aside>
      </main>
    </div>
  );
}
