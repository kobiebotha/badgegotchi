import { useEffect, useRef, useState, type FormEvent } from "react";
import { isAuthApiError } from "@supabase/supabase-js";
import { ArrowRight, Check, Heart, Leaf, Mail } from "lucide-react";
import { Brand } from "./Brand";
import { requestEmailCode, verifyEmailOtp } from "../lib/supabase";

function authErrorMessage(error: unknown, fallback: string): string {
  if (isAuthApiError(error)) {
    if (error.code === "over_email_send_rate_limit") {
      return "Sign-in emails are temporarily unavailable because the email service has reached its sending limit. Please try again later.";
    }
    if (error.code === "over_request_rate_limit" || error.status === 429) {
      return "Too many sign-in requests right now. Please wait a little before trying again.";
    }
  }
  return error instanceof Error ? error.message : fallback;
}

export function SignIn() {
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [codeWasRequested, setCodeWasRequested] = useState(false);
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<"send" | "resend" | "verify" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [resendAvailableAt, setResendAvailableAt] = useState(0);
  const [secondsUntilResend, setSecondsUntilResend] = useState(0);
  const requestInFlight = useRef(false);
  const busy = pending !== null;

  useEffect(() => {
    if (!sentTo || !resendAvailableAt) {
      setSecondsUntilResend(0);
      return;
    }
    const update = () =>
      setSecondsUntilResend(
        Math.max(0, Math.ceil((resendAvailableAt - Date.now()) / 1000)),
      );
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [sentTo, resendAvailableAt]);

  async function sendCode(address: string, resend = false) {
    if (requestInFlight.current || (resend && Date.now() < resendAvailableAt)) return;
    requestInFlight.current = true;
    setPending(resend ? "resend" : "send");
    setError("");
    setNotice("");
    try {
      await requestEmailCode(address);
      setEmail(address);
      setSentTo(address);
      setCodeWasRequested(true);
      setCode("");
      setResendAvailableAt(Date.now() + 60_000);
      if (resend) {
        setNotice("A new code is on its way. Use the newest email.");
      }
    } catch (error) {
      setError(
        authErrorMessage(error, "Couldn’t send your email code. Please try again."),
      );
    } finally {
      requestInFlight.current = false;
      setPending(null);
    }
  }

  function requestCode(event: FormEvent) {
    event.preventDefault();
    void sendCode(email.trim());
  }

  function enterExistingCode(form: HTMLFormElement | null) {
    if (requestInFlight.current || !form?.reportValidity()) return;
    const address = email.trim();
    setEmail(address);
    setSentTo(address);
    setCodeWasRequested(false);
    setCode("");
    setError("");
    setNotice("");
    setResendAvailableAt(0);
  }

  async function verifyCode(event: FormEvent) {
    event.preventDefault();
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setPending("verify");
    setError("");
    setNotice("");
    try {
      await verifyEmailOtp(sentTo, code.trim());
    } catch (error) {
      setError(
        authErrorMessage(
          error,
          "That code didn’t work. Try the newest code in your inbox.",
        ),
      );
    } finally {
      requestInFlight.current = false;
      setPending(null);
    }
  }

  return (
    <div className="landing">
      <header className="site-header">
        <Brand />
        <span className="header-note">
          <Leaf size={15} /> Make room for a good day
        </span>
      </header>
      <main className="sign-in-layout">
        <section className="welcome">
          <div className="pill">
            <span className="status-dot" /> A small companion for your workday
          </div>
          <h1>
            A little focus.
            <br />A little care.
          </h1>
          <p className="intro">
            Find your rhythm with a focus timer, gentle check-ins, and a little
            friend who’s always rooting for you.
          </p>
          <div className="welcome-pet">
            <span className="welcome-speech">We’ve got this, together.</span>
            <img
              src="/assets/animals/capybara.png"
              alt="A pixel-art capybara relaxing in a little garden"
            />
            <span className="tiny-heart">
              <Heart size={22} fill="currentColor" />
            </span>
          </div>
          <div className="welcome-notes">
            <span>
              <Check size={16} /> Focus at your pace
            </span>
            <span>
              <Check size={16} /> Keep your devices in sync
            </span>
          </div>
        </section>
        <section className="sign-in-card" aria-labelledby="sign-in-title">
          <span className="icon-tile">
            <Mail size={25} />
          </span>
          <p className="eyebrow">Your daily little ritual</p>
          <h2 id="sign-in-title">
            {sentTo ? "Enter your email code" : "Meet your companion"}
          </h2>
          <p>
            {sentTo
              ? codeWasRequested
                ? `Enter the sign-in code sent to ${sentTo}.`
                : `Enter the sign-in code for ${sentTo}.`
              : "We’ll email you a code to sign in or create your account."}
          </p>
          {sentTo ? (
            <form onSubmit={verifyCode} aria-busy={busy}>
              <label htmlFor="code">Email code</label>
              <input
                id="code"
                name="code"
                autoComplete="one-time-code"
                inputMode="numeric"
                pattern="[0-9]{6,8}"
                minLength={6}
                maxLength={8}
                required
                disabled={busy}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="6–8 digit code"
                autoFocus
              />
              <button
                className="button primary full"
                disabled={busy}
                type="submit"
              >
                {pending === "verify" ? "Verifying…" : "Verify code"}
                <ArrowRight size={18} />
              </button>
              <button
                className="text-button full"
                type="button"
                disabled={busy || secondsUntilResend > 0}
                onClick={() => void sendCode(sentTo, true)}
              >
                {pending === "resend"
                  ? "Sending a new code…"
                  : secondsUntilResend > 0
                    ? `Resend code (${secondsUntilResend}s)`
                    : "Resend code"}
              </button>
              <button
                className="text-button full"
                type="button"
                disabled={busy}
                onClick={() => {
                  setSentTo("");
                  setCodeWasRequested(false);
                  setError("");
                  setCode("");
                  setNotice("");
                  setResendAvailableAt(0);
                }}
              >
                Use a different email
              </button>
            </form>
          ) : (
            <form onSubmit={requestCode} aria-busy={busy}>
              <label htmlFor="email">Email address</label>
              <input
                id="email"
                type="email"
                name="email"
                autoComplete="email"
                required
                disabled={busy}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
              <button
                className="button primary full"
                disabled={busy}
                type="submit"
              >
                {pending === "send" ? "Sending…" : "Send email code"}
                <ArrowRight size={18} />
              </button>
              <button
                className="text-button full"
                disabled={busy}
                type="button"
                onClick={(event) => enterExistingCode(event.currentTarget.form)}
              >
                I already have a code
              </button>
            </form>
          )}
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          <p className="fine-print">
            No password to remember. Your email keeps your companion and
            progress together.
          </p>
        </section>
      </main>
      <footer className="site-footer">
        <span>A kinder kind of productivity.</span>
        <span>Made with PowerSync</span>
      </footer>
    </div>
  );
}
