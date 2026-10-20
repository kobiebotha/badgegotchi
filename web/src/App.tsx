import { useEffect, useState } from "react";
import { PowerSyncContext } from "@powersync/react";
import type { PowerSyncDatabase } from "@powersync/web";
import type { Session } from "@supabase/supabase-js";
import { configurationError } from "./lib/config";
import { getSupabaseClient } from "./lib/supabase";
import { clearUserDatabase, openUserDatabase } from "./lib/database";
import { SignIn } from "./components/SignIn";
import { Dashboard } from "./components/Dashboard";
import { Brand } from "./components/Brand";

export function App() {
  if (configurationError) {
    return (
      <main className="center-screen">
        <section className="message-card">
          <Brand />
          <h1>Let’s get connected.</h1>
          <p>{configurationError}</p>
          <p>
            Add the public settings from <code>web/.env.example</code> to{" "}
            <code>web/.env.local</code>, then restart the development server.
            For Vercel, set them in the project environment and rebuild.
          </p>
        </section>
      </main>
    );
  }
  return <AuthenticatedApp />;
}

function AuthenticatedApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [database, setDatabase] = useState<{
    userId: string;
    db: PowerSyncDatabase;
  } | null>(null);
  const [error, setError] = useState("");
  const userId = session?.user.id;

  useEffect(() => {
    const client = getSupabaseClient();
    let current = true;
    let authEventReceived = false;
    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((_event, next) => {
      authEventReceived = true;
      if (current) {
        setSession(next);
        setAuthReady(true);
      }
    });
    void client.auth
      .getSession()
      .then(({ data, error }) => {
        if (!current || authEventReceived) return;
        if (error) setError(error.message);
        setSession(data.session);
        setAuthReady(true);
      })
      .catch(() => {
        if (current) {
          setError(
            "Couldn’t restore your sign-in. Please reload to try again.",
          );
          setAuthReady(true);
        }
      });
    return () => {
      current = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!authReady) return;
    let current = true;
    setDatabase(null);
    setError("");
    if (!userId) {
      void clearUserDatabase().catch((error: unknown) => {
        if (current)
          setError(
            error instanceof Error
              ? error.message
              : "Couldn’t clear local data.",
          );
      });
    } else {
      void openUserDatabase(userId)
        .then((db) => {
          if (current) setDatabase({ userId, db });
        })
        .catch((error: unknown) => {
          if (current)
            setError(
              error instanceof Error
                ? error.message
                : "Couldn’t open your saved data.",
            );
        });
    }
    return () => {
      current = false;
    };
  }, [authReady, userId]);

  if (error) {
    return (
      <main className="center-screen">
        <section className="message-card">
          <Brand />
          <h1>We hit a snag.</h1>
          <p role="alert">{error}</p>
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
  if (authReady && !session) return <SignIn />;
  if (!authReady || !session || !database || database.userId !== userId) {
    return (
      <main className="center-screen">
        <div className="loading-companion" role="status">
          <img src="/assets/icons/capybara-icon-64.png" alt="" />
          <p>Settling in…</p>
        </div>
      </main>
    );
  }
  return (
    <PowerSyncContext.Provider value={database.db}>
      <Dashboard
        key={session.user.id}
        db={database.db}
        userId={session.user.id}
        email={session.user.email ?? ""}
      />
    </PowerSyncContext.Provider>
  );
}
