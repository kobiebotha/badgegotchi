import { UpdateType } from "@powersync/web";
import type {
  CommonPowerSyncDatabase,
  PowerSyncBackendConnector,
  PowerSyncCredentials,
} from "@powersync/web";
import type { PublicConfig } from "./config";
import {
  assertResponse,
  authHeaders,
  currentSession,
  invokePetCommand,
  requireSession,
} from "./backend";
import type { AuthClient, Request } from "./backend";

const writableColumns: Record<string, readonly string[]> = {
  sessions: [
    "day_key",
    "type",
    "planned_duration_seconds",
    "state",
    "outcome",
    "started_at",
    "last_resumed_at",
    "paused_at",
    "ended_at",
    "remaining_seconds_at_pause",
  ],
  wellness_events: ["day_key", "type", "occurred_at"],
  // Cached totals are recomputed from raw rows by each client. Uploading them
  // would let an incomplete local snapshot overwrite another device's counts.
  daily_activity_summary: [
    "day_key",
    "hydration_timer_anchor_at",
    "hydration_reminder_active",
    "updated_at",
  ],
};
const petIntentColumns = [
  "pet_session_id",
  "event_type",
  "source_device",
  "created_at",
] as const;

export interface UploadOperation {
  table: string;
  op: UpdateType;
  id: string;
  opData?: Record<string, unknown> | null;
}

function pick(
  data: Record<string, unknown> | null | undefined,
  columns: readonly string[],
) {
  return Object.fromEntries(
    columns
      .filter((key) => data && Object.hasOwn(data, key))
      .map((key) => [key, data![key]]),
  );
}

export class SupabaseConnector implements PowerSyncBackendConnector {
  constructor(
    private readonly client: AuthClient,
    private readonly config: PublicConfig,
    private readonly userId: string,
    private readonly request: Request = fetch,
  ) {}

  async fetchCredentials(): Promise<PowerSyncCredentials | null> {
    const session = await currentSession(this.client, this.userId);
    if (!session) return null;
    return {
      endpoint: this.config.powersyncUrl,
      token: session.access_token,
      expiresAt: session.expires_at
        ? new Date(session.expires_at * 1000)
        : undefined,
    };
  }

  async uploadData(database: CommonPowerSyncDatabase): Promise<void> {
    await requireSession(this.client, this.userId);
    const transaction = await database.getNextCrudTransaction();
    if (!transaction) return;
    for (const operation of transaction.crud)
      await this.uploadOperation(operation);
    // Never acknowledge writes that failed validation, authorization, or AI
    // processing. Throwing leaves the same durable transaction queued for retry.
    await transaction.complete();
  }

  async uploadOperation(operation: UploadOperation): Promise<void> {
    const session = await requireSession(this.client, this.userId);
    const { table, op, id, opData } = operation;
    if (table === "pet_events") {
      if (op !== UpdateType.PUT || !opData) {
        throw new Error("Pet events are append-only client intentions.");
      }
      await invokePetCommand(
        this.client,
        this.config,
        { action: "react", event: { ...pick(opData, petIntentColumns), id } },
        this.userId,
        this.request,
      );
      return;
    }
    if (!Object.hasOwn(writableColumns, table)) {
      throw new Error(`Client writes to ${table} are not allowed.`);
    }
    if (![UpdateType.PUT, UpdateType.PATCH, UpdateType.DELETE].includes(op)) {
      throw new Error("Unsupported upload operation.");
    }
    const data = pick(opData, writableColumns[table]);
    if (op === UpdateType.PATCH && Object.keys(data).length === 0) return;
    if (op !== UpdateType.DELETE && !opData)
      throw new Error("Upload data is missing.");

    const url = new URL(
      `${this.config.supabaseUrl.replace(/\/$/, "")}/rest/v1/${table}`,
    );
    const headers = authHeaders(this.config, session);
    let method: string;
    let body: string | undefined;
    if (op === UpdateType.PUT) {
      method = "POST";
      url.searchParams.set("on_conflict", "id");
      headers.Prefer = "resolution=merge-duplicates,return=minimal";
      body = JSON.stringify({ ...data, id });
    } else {
      method = op === UpdateType.PATCH ? "PATCH" : "DELETE";
      url.searchParams.set("id", `eq.${id}`);
      headers.Prefer = "return=minimal";
      if (op === UpdateType.PATCH) body = JSON.stringify(data);
    }
    // Native browser fetch rejects the connector object as its receiver.
    const request = this.request;
    const response = await request(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(30_000),
    });
    await assertResponse(response, "Sync upload");
  }
}
