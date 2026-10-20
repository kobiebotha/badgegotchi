import { useState, type FormEvent } from "react";
import { ArrowRight, Check, Heart, Leaf, Mail } from "lucide-react";
import { Brand } from "./Brand";
import { requestMagicLink, verifyEmailOtp } from "../lib/supabase";

export function SignIn() {
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function sendLink(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await requestMagicLink(email.trim());
      setSentTo(email.trim());
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Couldn’t send your sign-in email. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await verifyEmailOtp(sentTo, code.trim());
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "That code didn’t work. Try the newest code in your inbox.",
      );
    } finally {
      setBusy(false);
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
            {sentTo ? "Check your inbox" : "Meet your companion"}
          </h2>
          <p>
            {sentTo
              ? `We sent a sign-in link to ${sentTo}. Open it here, or enter the email code below.`
              : "Sign in with your email to bring your pet and your progress along."}
          </p>
          {sentTo ? (
            <form onSubmit={verifyCode}>
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
                {busy ? "Verifying…" : "Let’s settle in"}
                <ArrowRight size={18} />
              </button>
              <button
                className="text-button full"
                type="button"
                disabled={busy}
                onClick={() => {
                  setSentTo("");
                  setError("");
                  setCode("");
                }}
              >
                Use a different email or resend
              </button>
            </form>
          ) : (
            <form onSubmit={sendLink}>
              <label htmlFor="email">Email address</label>
              <input
                id="email"
                type="email"
                name="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
              <button
                className="button primary full"
                disabled={busy}
                type="submit"
              >
                {busy ? "Sending…" : "Send sign-in link"}
                <ArrowRight size={18} />
              </button>
            </form>
          )}
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
          <p className="fine-print">
            No password to remember. Use the same email as your Mac app to pick
            up where you left off.
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
