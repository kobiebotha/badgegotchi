import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Cable,
  Check,
  CheckCircle2,
  Download,
  Info,
  LoaderCircle,
  Monitor,
  RefreshCw,
  ShieldCheck,
  Usb,
} from "lucide-react";
import { Brand } from "./Brand";
import {
  downloadFirmware,
  loadRelease,
  type FirmwareRelease,
} from "../installer/release";
import {
  connectPicoboot,
  type InstallProgress,
  type PicobootConnection,
} from "../installer/picoboot";
import "./installer.css";

type PreparedFirmware = Awaited<ReturnType<typeof downloadFirmware>>;
type ReleaseState = "loading" | "unpublished" | "checking" | "ready" | "error";

const phases: { phase: InstallProgress["phase"]; label: string }[] = [
  { phase: "preparing", label: "Preparing the badge" },
  { phase: "writing", label: "Installing firmware" },
  { phase: "verifying", label: "Checking the installation" },
  { phase: "rebooting", label: "Restarting the badge" },
];

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "NotFoundError") {
      return "No badge was selected. Put your badge in BOOTSEL mode, then choose Connect badge to try again.";
    }
    if (error.name === "SecurityError") {
      return "The browser blocked USB access. Open this page directly in Chrome or Edge over HTTPS, or use the manual installation below.";
    }
    return error.message;
  }
  return "The badge couldn’t be reached. Reconnect it in BOOTSEL mode and try again.";
}

function supportsWebUsb(): boolean {
  const usb = (navigator as unknown as { usb?: { requestDevice?: unknown } }).usb;
  return (
    window.isSecureContext &&
    typeof usb?.requestDevice === "function"
  );
}

export function BadgeInstaller() {
  const [release, setRelease] = useState<FirmwareRelease | null>(null);
  const [firmware, setFirmware] = useState<PreparedFirmware | null>(null);
  const [releaseState, setReleaseState] = useState<ReleaseState>("loading");
  const [releaseError, setReleaseError] = useState("");
  const [reload, setReload] = useState(0);
  const [boardConfirmed, setBoardConfirmed] = useState(false);
  const [replacementConfirmed, setReplacementConfirmed] = useState(false);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [complete, setComplete] = useState(false);
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [installError, setInstallError] = useState("");
  const [downloadNotice, setDownloadNotice] = useState("");
  const [webUsbSupported] = useState(supportsWebUsb);
  const connectionRef = useRef<PicobootConnection | null>(null);
  const operationRef = useRef<"connecting" | "installing" | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const consent = boardConfirmed && replacementConfirmed;
  const busy = connecting || installing;
  const ready = releaseState === "ready" && firmware !== null;
  // Erase and write alternate for each sector. Present them as one stage so the
  // completed steps do not move backward on every sector.
  const displayPhase = progress?.phase === "erasing" ? "writing" : progress?.phase;
  const activePhaseIndex = progress
    ? phases.findIndex(({ phase }) => phase === displayPhase)
    : 0;
  const phaseLabel = phases[activePhaseIndex]?.label ?? "Preparing the badge";
  const phasePercent = progress
    ? Math.min(
        100,
        Math.max(0, Math.round((progress.completed / Math.max(1, progress.total)) * 100)),
      )
    : 0;

  useEffect(() => {
    mountedRef.current = true;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (operationRef.current !== "installing") return;
      event.preventDefault();
      event.returnValue = "";
    };
    const usb = (navigator as unknown as { usb?: EventTarget }).usb;
    const disconnected = (event: Event) => {
      if (operationRef.current === "installing") return;
      const connection = connectionRef.current;
      if (!connection?.matchesDevice((event as Event & { device: unknown }).device)) {
        return;
      }
      connectionRef.current = null;
      setDeviceName(null);
      setInstallError("The badge was disconnected. Reconnect it in BOOTSEL mode, then choose Connect badge again.");
      void connection.close().catch(() => undefined);
    };
    window.addEventListener("beforeunload", beforeUnload);
    usb?.addEventListener?.("disconnect", disconnected);
    return () => {
      mountedRef.current = false;
      window.removeEventListener("beforeunload", beforeUnload);
      usb?.removeEventListener?.("disconnect", disconnected);
      abortRef.current?.abort();
      const connection = connectionRef.current;
      connectionRef.current = null;
      void connection?.close().catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setReleaseState("loading");
    setReleaseError("");
    setFirmware(null);
    setRelease(null);
    void (async () => {
      try {
        const nextRelease = await loadRelease(controller.signal);
        if (!current) return;
        setRelease(nextRelease);
        if (!nextRelease) {
          setReleaseState("unpublished");
          return;
        }
        setReleaseState("checking");
        // Prepare and verify the entire image before the user opens the USB chooser.
        const prepared = await downloadFirmware(nextRelease, controller.signal);
        if (!current) return;
        setFirmware(prepared);
        setReleaseState("ready");
      } catch (error) {
        if (!current) return;
        setReleaseState("error");
        setReleaseError(
          error instanceof Error
            ? error.message
            : "The firmware could not be checked. Please try again.",
        );
      }
    })();
    return () => {
      current = false;
      controller.abort();
    };
  }, [reload]);

  async function connect() {
    if (operationRef.current || connectionRef.current || !ready || !webUsbSupported) {
      return;
    }
    operationRef.current = "connecting";
    setConnecting(true);
    setInstallError("");
    setComplete(false);
    setProgress(null);
    try {
      // This call must remain in the click handler, before any asynchronous work.
      const connection = await connectPicoboot();
      if (!mountedRef.current) {
        await connection.close();
        return;
      }
      connectionRef.current = connection;
      setDeviceName(connection.deviceName || "RP2350 badge");
    } catch (error) {
      if (mountedRef.current) setInstallError(errorMessage(error));
    } finally {
      operationRef.current = null;
      if (mountedRef.current) setConnecting(false);
    }
  }

  async function disconnect() {
    if (operationRef.current) return;
    const connection = connectionRef.current;
    connectionRef.current = null;
    setDeviceName(null);
    await connection?.close().catch(() => undefined);
  }

  async function install() {
    const connection = connectionRef.current;
    if (operationRef.current || !connection || !firmware || !consent) return;
    operationRef.current = "installing";
    const controller = new AbortController();
    abortRef.current = controller;
    setInstalling(true);
    setComplete(false);
    setInstallError("");
    setProgress({ phase: "preparing", completed: 0, total: 1 });
    try {
      await connection.install(firmware.image, {
        signal: controller.signal,
        onProgress: (next) => {
          if (mountedRef.current) setProgress(next);
        },
      });
      if (mountedRef.current) setComplete(true);
    } catch (error) {
      if (mountedRef.current) {
        setInstallError(
          `${errorMessage(error)} The installation did not finish. Hold BOOT while pressing and releasing RESET, then reconnect and reinstall.`,
        );
      }
    } finally {
      await connection.close().catch(() => undefined);
      connectionRef.current = null;
      abortRef.current = null;
      operationRef.current = null;
      if (mountedRef.current) {
        setDeviceName(null);
        setInstalling(false);
      }
    }
  }

  function saveFirmware() {
    if (!firmware || !release || !consent || busy) return;
    const bytes = new Uint8Array(firmware.bytes);
    const url = URL.createObjectURL(
      new Blob([bytes.buffer], { type: "application/octet-stream" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `badgegotchi-tufty2350-${release.version.replace(/[^a-zA-Z0-9._-]/g, "-")}.uf2`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    setDownloadNotice("Firmware download started. Follow the manual steps below to install it.");
  }

  return (
    <div className="landing installer-page">
      <header
        className="site-header"
        onClickCapture={(event) => {
          if (installing && (event.target as Element).closest("a")) {
            event.preventDefault();
          }
        }}
      >
        <Brand />
        <a
          className="installer-home-link"
          href="/"
          aria-disabled={installing || undefined}
          tabIndex={installing ? -1 : undefined}
        >
          <ArrowLeft size={15} /> Back to your companion
        </a>
      </header>

      <main className="installer-main">
        <section className="installer-intro" aria-labelledby="installer-title">
          <div>
            <span className="pill">
              <Usb size={14} aria-hidden="true" /> For Pimoroni Tufty 2350
            </span>
            <h1 id="installer-title">
              A little friend.
              <br />
              Ready to come along.
            </h1>
            <p>
              Install Badgegotchi on your badge from this browser. You’ll need
              your Tufty 2350, a USB data cable, and a few quiet minutes.
            </p>
            <span className="installer-intro-note">
              <Monitor size={15} aria-hidden="true" /> Desktop Chrome or Edge recommended
            </span>
          </div>
          <div className="installer-badge-scene" aria-hidden="true">
            <span className="installer-floating-note">A new home for your companion</span>
            <div className="installer-badge">
              <span className="installer-badge-slot" />
              <div className="installer-badge-screen">
                <span>badgegotchi.</span>
                <img src="/assets/animals/capybara.png" alt="" />
                <span className="installer-badge-caption">One little step at a time.</span>
              </div>
              <div className="installer-badge-buttons">
                <i /><i /><i />
              </div>
            </div>
            <span className="installer-cable" />
          </div>
        </section>

        <ol className="installer-overview" aria-label="Installation steps">
          <li><span>1</span><div>Get ready<small>Connect your badge in BOOTSEL mode</small></div></li>
          <li><span>2</span><div>Choose your badge<small>Allow this browser to connect over USB</small></div></li>
          <li><span>3</span><div>Install Badgegotchi<small>Keep the cable connected until it finishes</small></div></li>
        </ol>

        <div className="installer-workspace">
          <section className="installer-setup panel" aria-labelledby="prepare-title">
            <div className="installer-section-heading">
              <span className="installer-icon-tile"><Cable size={22} aria-hidden="true" /></span>
              <div><p className="eyebrow">Before you connect</p><h2 id="prepare-title">Get your badge ready</h2></div>
            </div>
            <ol className="installer-instructions">
              <li>Connect your <strong>Tufty 2350</strong> to this computer with a USB data cable.</li>
              <li>Hold the <kbd>BOOT</kbd> button on the back of the badge.</li>
              <li>While holding BOOT, press and release <kbd>RESET</kbd>. Then release BOOT.</li>
              <li>Your computer should show a drive called <strong>RP2350</strong>. Your badge is now ready.</li>
            </ol>
            <p className="installer-setup-tip">
              Double-tapping RESET opens the Badgeware file drive instead. Use
              BOOT + RESET for this installer.
            </p>
            <div className="installer-replacement-note">
              <Info size={19} aria-hidden="true" />
              <div>
                <strong>This replaces the badge’s current firmware.</strong>
                <p>
                  The Badgeware launcher and its apps will no longer run. Save
                  anything you want to keep before installing. You can restore
                  Badgeware later using its original firmware.
                </p>
              </div>
            </div>
            <fieldset className="installer-consent" disabled={!ready || busy || complete}>
              <legend>Confirm before installing</legend>
              <label>
                <input
                  type="checkbox"
                  checked={boardConfirmed}
                  onChange={(event) => setBoardConfirmed(event.target.checked)}
                />
                <span>My badge is a <strong>Pimoroni Tufty 2350</strong>.</span>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={replacementConfirmed}
                  onChange={(event) => setReplacementConfirmed(event.target.checked)}
                />
                <span>I’ve saved what I need and agree to replace its current firmware.</span>
              </label>
            </fieldset>
          </section>

          <section
            className="installer-action panel"
            aria-labelledby="install-title"
            aria-busy={connecting || releaseState === "loading" || releaseState === "checking"}
          >
            <div className="installer-section-heading">
              <span className="installer-icon-tile"><Usb size={22} aria-hidden="true" /></span>
              <div><p className="eyebrow">Your next step</p><h2 id="install-title">Install from your browser</h2></div>
            </div>

            {releaseState === "unpublished" ? (
              <div className="installer-release-pending">
                <span className="installer-status-icon"><LeafMark /></span>
                <h3>Firmware is being prepared</h3>
                <p>
                  A complete Badgegotchi firmware hasn’t been published yet.
                  USB installation also needs validation on a physical Tufty
                  2350. Installation will be available once both are ready.
                </p>
                <button className="button primary full" disabled>
                  <Usb size={17} aria-hidden="true" /> Connect badge
                </button>
                <p className="installer-small-note">You can review the setup steps while it’s being prepared.</p>
              </div>
            ) : releaseState === "loading" || releaseState === "checking" ? (
              <div className="installer-loading" role="status">
                <LoaderCircle className="installer-spin" size={25} aria-hidden="true" />
                <h3>{releaseState === "loading" ? "Checking for firmware…" : "Checking your firmware download…"}</h3>
                <p>The download is verified before the badge can be connected.</p>
              </div>
            ) : releaseState === "error" ? (
              <div className="installer-release-error">
                <h3>Firmware couldn’t be verified</h3>
                <p role="alert">{releaseError}</p>
                <p>Installation is unavailable until the firmware has been checked.</p>
                <button className="button secondary" onClick={() => setReload((value) => value + 1)}>
                  <RefreshCw size={16} aria-hidden="true" /> Try again
                </button>
              </div>
            ) : (
              <>
                <div className="installer-release-summary">
                  <ShieldCheck size={22} aria-hidden="true" />
                  <div>
                    <strong>{release?.name ?? "Badgegotchi for Tufty 2350"}</strong>
                    <span>Version {release?.version} · Download verified</span>
                  </div>
                </div>
                {release?.description && <p className="installer-release-description">{release.description}</p>}

                {complete ? (
                  <div className="installer-success" role="status">
                    <CheckCircle2 size={35} aria-hidden="true" />
                    <h3>Firmware installed</h3>
                    <p>
                      The firmware was written and verified. Check your badge’s
                      screen as it restarts.
                    </p>
                    <p>
                      This installs the software only. It doesn’t connect Wi-Fi
                      or pair the badge with your account.
                    </p>
                  </div>
                ) : installing ? (
                  <div className="installer-progress">
                    <div className="installer-progress-heading" role="status">
                      <LoaderCircle className="installer-spin" size={20} aria-hidden="true" />
                      <strong>{phaseLabel}</strong>
                    </div>
                    <div
                      className="installer-progress-track"
                      role="progressbar"
                      aria-label={phaseLabel}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={phasePercent}
                    >
                      <span style={{ width: `${phasePercent}%` }} />
                    </div>
                    <ol className="installer-progress-phases" aria-label="Installation progress">
                      {phases.map(({ phase, label }, index) => (
                        <li key={phase} className={index <= activePhaseIndex ? "is-current" : ""}>
                          {index < activePhaseIndex ? <Check size={14} aria-label="Complete" /> : <span className="installer-phase-dot" />}
                          {label}
                        </li>
                      ))}
                    </ol>
                    <p className="installer-stay-connected">Keep this tab open and leave the USB cable connected.</p>
                  </div>
                ) : !webUsbSupported ? (
                  <div className="installer-browser-note">
                    <h3>This browser can’t connect over USB</h3>
                    <p>
                      Open this page in desktop Chrome or Edge over HTTPS, or
                      download the verified firmware and install it manually below.
                    </p>
                  </div>
                ) : deviceName ? (
                  <div className="installer-device-ready">
                    <p className="installer-connected"><CheckCircle2 size={18} aria-hidden="true" /> Connected: {deviceName}</p>
                    <p>
                      The USB connection identifies the RP2350 chip, so please
                      confirm the badge model and firmware replacement on the left.
                    </p>
                    <button className="button primary full" disabled={!consent} onClick={() => void install()}>
                      Install &amp; replace firmware <ArrowRight size={17} aria-hidden="true" />
                    </button>
                    <button className="text-button full" onClick={() => void disconnect()}>Disconnect badge</button>
                  </div>
                ) : (
                  <div className="installer-connect">
                    <p>Choose your badge in the browser’s USB picker. Connecting alone doesn’t install or erase anything.</p>
                    <button className="button primary full" disabled={connecting} onClick={() => void connect()}>
                      {connecting ? <LoaderCircle className="installer-spin" size={17} aria-hidden="true" /> : <Usb size={17} aria-hidden="true" />}
                      {connecting ? "Connecting…" : "Connect badge"}
                    </button>
                    <p className="installer-small-note">Choose the RP2350 device. Close other tabs or tools that are using the badge.</p>
                  </div>
                )}
                {installError && <p className="error-message installer-error" role="alert">{installError}</p>}
              </>
            )}

            <details className="installer-manual" open={!webUsbSupported || undefined}>
              <summary><Download size={16} aria-hidden="true" /> Install with a firmware file</summary>
              <div>
                <p>
                  You can install the same verified firmware without browser USB access.
                  Confirm the badge model and replacement above first.
                </p>
                <ol>
                  <li>Download the firmware file below.</li>
                  <li>Put the badge in BOOTSEL mode using BOOT + RESET.</li>
                  <li>Drag the <code>.uf2</code> file onto the <strong>RP2350</strong> drive.</li>
                  <li>Wait for the copy to finish. The badge will restart automatically.</li>
                </ol>
                <button
                  className="button secondary full"
                  disabled={!ready || !consent || busy || complete}
                  onClick={saveFirmware}
                >
                  <Download size={16} aria-hidden="true" /> Download verified firmware
                </button>
                {downloadNotice && <p className="installer-small-note" role="status">{downloadNotice}</p>}
              </div>
            </details>
          </section>
        </div>

        <aside className="installer-recovery" aria-labelledby="recovery-title">
          <RefreshCw size={20} aria-hidden="true" />
          <div>
            <h2 id="recovery-title">Unplugged before it finished?</h2>
            <p>
              Reconnect the cable. Hold BOOT while pressing and releasing RESET,
              then release BOOT and run the installer again. BOOTSEL mode remains
              available even if an installation is interrupted.
            </p>
          </div>
        </aside>
      </main>

      <footer className="site-footer">
        <span>A little companion, a little closer.</span>
        <span>Made with PowerSync</span>
      </footer>
    </div>
  );
}

function LeafMark() {
  return <img src="/assets/icons/capybara-icon-64.png" width="48" height="48" alt="" />;
}
