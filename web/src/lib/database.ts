import { PowerSyncDatabase, WASQLiteVFS } from "@powersync/web";
import { requireSession } from "./backend";
import { requireConfig } from "./config";
import { SupabaseConnector } from "./connector";
import { UserDatabaseOwner } from "./databaseOwner";
import { AppSchema } from "./schema";
import { getSupabaseClient } from "./supabase";

export function databaseFilename(userId: string): string {
  return `badgegotchi-${encodeURIComponent(userId)}.db`;
}

const owner = new UserDatabaseOwner(
  async (userId) => {
    const database = new PowerSyncDatabase({
      schema: AppSchema,
      database: {
        dbFilename: databaseFilename(userId),
        vfs: WASQLiteVFS.IDBBatchAtomicVFS,
      },
    });
    try {
      await database.init();
      return database;
    } catch (error) {
      await database.close();
      throw error;
    }
  },
  async (userId) => {
    await requireSession(getSupabaseClient(), userId);
  },
  async (database, userId) => {
    // connect can remain pending until its first network attempt settles.
    // Local data must become available immediately, including while offline.
    // The SDK reports connection/upload errors through useStatus and retries.
    void database
      .connect(
        new SupabaseConnector(getSupabaseClient(), requireConfig(), userId),
        { diagnostics: import.meta.env.DEV },
      )
      .catch(() => {
        console.warn(
          "PowerSync connection unavailable; local changes remain on this device.",
        );
      });
  },
);

/** Never close this handle from a React effect cleanup. */
export async function openUserDatabase(
  userId: string,
): Promise<PowerSyncDatabase> {
  return owner.open(userId);
}

export async function clearUserDatabase(): Promise<void> {
  await owner.clear();
}

/** UI confirms discarding any pending writes before calling this operation. */
export async function signOut(): Promise<void> {
  // Removing the session immediately prevents further uploads. The app's auth
  // observer hides account content before awaiting this same serialized cleanup.
  const { error } = await getSupabaseClient().auth.signOut({ scope: "local" });
  if (error) throw error;
  await clearUserDatabase();
}
