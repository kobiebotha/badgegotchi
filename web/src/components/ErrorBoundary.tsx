import { Component, type ReactNode } from "react";

export class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="center-screen">
          <section className="message-card">
            <p className="eyebrow">Badgegotchi</p>
            <h1>A little hiccup.</h1>
            <p>
              We couldn’t open your companion. Reload to try again. Your saved
              local data is still here.
            </p>
            <button
              className="button primary"
              onClick={() => window.location.reload()}
            >
              Try again
            </button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}
