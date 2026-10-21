import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdateType } from '@powersync/web';
import type { CommonPowerSyncDatabase } from '@powersync/web';
import type { Session } from '@supabase/supabase-js';
import { AccountChangedError, invokePetCommand } from '../src/lib/backend';
import type { AuthClient } from '../src/lib/backend';
import { SupabaseConnector } from '../src/lib/connector';
import type { UploadOperation } from '../src/lib/connector';
import { validateConfig } from '../src/lib/config';

const config = {
  supabaseUrl: 'https://test.supabase.co',
  supabaseKey: 'sb_publishable_test',
  powersyncUrl: 'https://test.powersync.journeyapps.com',
};
const event: UploadOperation = {
  table: 'pet_events',
  op: UpdateType.PUT,
  id: 'event-1',
  opData: {
    pet_session_id: 'pet-1',
    event_type: 'pet_pet',
    source_device: 'web',
    created_at: '2026-10-20T12:00:00.000Z',
    status: 'completed',
    reaction_speech: 'untrusted response',
    owner_id: 'another-user',
  },
};

describe('SupabaseConnector', () => {
  let session: Session | null;
  let client: AuthClient;
  let request: ReturnType<typeof vi.fn<typeof fetch>>;
  let connector: SupabaseConnector;

  beforeEach(() => {
    session = { user: { id: 'user-1' }, access_token: 'token-1', expires_at: 1_800_000_000 } as Session;
    client = { auth: { getSession: vi.fn(async () => ({ data: { session }, error: null })) } } as unknown as AuthClient;
    request = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 204 }));
    connector = new SupabaseConnector(client, config, 'user-1', request);
  });

  function transaction(operations: UploadOperation[]) {
    const complete = vi.fn(async () => undefined);
    const tx = { crud: operations, complete };
    const database = {
      getNextCrudTransaction: vi.fn(async () => tx),
    } as unknown as CommonPowerSyncDatabase;
    return { database, complete };
  }

  it('uploads through native browser fetch without binding it to the connector', async () => {
    // WebIDL permits a global/undefined receiver, but rejects a foreign object.
    // Arrow-function request mocks hide this browser-only failure.
    const browserFetch = vi.fn(function (this: unknown, ..._args: Parameters<typeof fetch>) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    vi.stubGlobal('fetch', browserFetch);
    try {
      const browserConnector = new SupabaseConnector(client, config, 'user-1');
      const { database, complete } = transaction([
        { table: 'wellness_events', op: UpdateType.PUT, id: 'wellness-1', opData: { type: 'hydration' } },
        event,
      ]);
      await browserConnector.uploadData(database);
      expect(browserFetch).toHaveBeenCalledTimes(2);
      expect(complete).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('preserves legacy pending timer writes instead of overwriting the shared timer', async () => {
    const { database, complete } = transaction([{ table:'sessions',op:UpdateType.PATCH,id:'old',opData:{state:'paused'} }]);
    await expect(connector.uploadData(database)).rejects.toThrow('older app queued a timer edit');
    expect(complete).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each(['accepted', 'rejected'] as const)('acknowledges a terminal %s command with its durable receipt', async (state) => {
    const command = { id:'command-1',type:'timer_start',occurred_at:'2026-10-20T12:00:00Z',new_session_id:'command-1',session_type:'focus',expected_revision:'0' };
    const receipt = { state,command_id:'command-1',revision:'1' };
    request.mockResolvedValueOnce(Response.json(receipt));
    const { database, complete } = transaction([{ table:'account_commands',op:UpdateType.PUT,id:command.id,opData:{payload:JSON.stringify(command)} }]);
    database.execute = vi.fn(async () => ({})) as unknown as typeof database.execute;
    await connector.uploadData(database);
    expect(JSON.parse(request.mock.calls[0][1]!.body as string)).toEqual({action:'command',command});
    expect(String(request.mock.calls[0][0])).toContain('/functions/v1/badge-gateway');
    expect(database.execute).toHaveBeenCalledWith('UPDATE pending_commands SET status = ?, receipt = ? WHERE id = ?', [state,JSON.stringify(receipt),'command-1']);
    expect(complete).toHaveBeenCalledOnce();
  });

  it('retries a lost command response with the same command identity and body', async () => {
    const command = { id:'command-1',type:'hydration',occurred_at:'2026-10-20T12:00:00Z' };
    const { database, complete } = transaction([{table:'account_commands',op:UpdateType.PUT,id:command.id,opData:{payload:JSON.stringify(command)}}]);
    database.execute = vi.fn(async () => ({})) as unknown as typeof database.execute;
    request.mockRejectedValueOnce(new Error('connection lost')).mockResolvedValueOnce(Response.json({state:'accepted',command_id:'command-1',revision:'0'}));
    await expect(connector.uploadData(database)).rejects.toThrow('connection lost');
    expect(complete).not.toHaveBeenCalled();
    await connector.uploadData(database);
    expect(request.mock.calls[0][1]!.body).toBe(request.mock.calls[1][1]!.body);
    expect(complete).toHaveBeenCalledOnce();
  });

  it('retains commands if the service returns a mismatched receipt', async () => {
    const { database, complete } = transaction([{table:'account_commands',op:UpdateType.PUT,id:'expected',opData:{payload:JSON.stringify({id:'expected',type:'hydration'})}}]);
    request.mockResolvedValueOnce(Response.json({state:'accepted',command_id:'different',revision:'0'}));
    await expect(connector.uploadData(database)).rejects.toThrow('invalid receipt');
    expect(complete).not.toHaveBeenCalled();
  });

  it('reads current tokens for every credentials request and rejects another account', async () => {
    expect(await connector.fetchCredentials()).toMatchObject({ token: 'token-1', endpoint: config.powersyncUrl });
    session = { ...session!, access_token: 'token-2' };
    expect(await connector.fetchCredentials()).toMatchObject({ token: 'token-2' });
    session = { ...session!, user: { id: 'user-2' } } as Session;
    expect(await connector.fetchCredentials()).toBeNull();
    await expect(connector.uploadOperation(event)).rejects.toBeInstanceOf(AccountChangedError);
    expect(request).not.toHaveBeenCalled();
  });

  it('uploads only pet intentions through the existing react command', async () => {
    await connector.uploadOperation(event);
    const [url, init] = request.mock.calls[0];
    expect(url).toBe(`${config.supabaseUrl}/functions/v1/pet-ai`);
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer token-1' });
    expect(JSON.parse(init!.body as string)).toEqual({
      action: 'react',
      event: {
        id: 'event-1',
        pet_session_id: 'pet-1',
        event_type: 'pet_pet',
        source_device: 'web',
        created_at: '2026-10-20T12:00:00.000Z',
      },
    });
  });

  it('retains failed inference transactions for retry with the same event ID', async () => {
    const { database, complete } = transaction([event]);
    request.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(connector.uploadData(database)).rejects.toThrow('503');
    expect(complete).not.toHaveBeenCalled();
    await connector.uploadData(database);
    expect(complete).toHaveBeenCalledOnce();
    const bodies = request.mock.calls.map(([, init]) => JSON.parse(init!.body as string));
    expect(bodies[0].event.id).toBe(bodies[1].event.id);
  });

  it('acknowledges terminal server rejection after a pet reset', async () => {
    const { database, complete } = transaction([event]);
    request.mockResolvedValueOnce(Response.json({ status: 'rejected', reason: 'pet_reset' }));
    await connector.uploadData(database);
    expect(complete).toHaveBeenCalledOnce();
  });

  it.each([
    { ...event, table: 'pet_sessions' },
    { ...event, op: UpdateType.PATCH },
    { ...event, op: UpdateType.DELETE },
    { ...event, table: 'unknown_table' },
    { ...event, table: '__proto__' },
  ])('rejects unauthorized write to $table with $op', async (operation) => {
    await expect(connector.uploadOperation(operation)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it('never uploads stale summary counters or caller-supplied ownership', async () => {
    await connector.uploadOperation({
      table: 'daily_activity_summary',
      op: UpdateType.PUT,
      id: 'user-1:2026-10-20',
      opData: {
        day_key: '2026-10-20',
        owner_id: 'user-2',
        hydration_count: 0,
        last_hydration_at: null,
        ended_focus_count: 0,
        hydration_timer_anchor_at: '2026-10-20T12:00:00.000Z',
        hydration_reminder_active: 1,
        updated_at: '2026-10-20T12:00:00.000Z',
      },
    });
    expect(JSON.parse(request.mock.calls[0][1]!.body as string)).toEqual({
      id: 'user-1:2026-10-20',
      day_key: '2026-10-20',
      hydration_timer_anchor_at: '2026-10-20T12:00:00.000Z',
      hydration_reminder_active: 1,
      updated_at: '2026-10-20T12:00:00.000Z',
    });
    await connector.uploadOperation({
      table: 'daily_activity_summary', op: UpdateType.PATCH, id: 'day-1', opData: { hydration_count: 0 },
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it('maps normal CRUD operations and pins the checked identity to the request', async () => {
    await connector.uploadOperation({
      table: 'wellness_events', op: UpdateType.PUT, id: 'session-1',
      opData: { type: 'hydration', owner_id: 'user-2', id: 'forged-id' },
    });
    await connector.uploadOperation({
      table: 'wellness_events', op: UpdateType.PATCH, id: 'session-1', opData: { type: 'movement' },
    });
    await connector.uploadOperation({ table: 'wellness_events', op: UpdateType.DELETE, id: 'session-1' });
    expect(request.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'PATCH', 'DELETE']);
    expect(JSON.parse(request.mock.calls[0][1]!.body as string)).toEqual({ id: 'session-1', type: 'hydration' });
    expect(String(request.mock.calls[1][0])).toContain('id=eq.session-1');
    expect(request.mock.calls[2][1]!.headers).toMatchObject({ Authorization: 'Bearer token-1' });
  });

  it('does not continue uploading a transaction after the signed-in identity changes', async () => {
    const { database, complete } = transaction([
      { table: 'wellness_events', op: UpdateType.PUT, id: 'a', opData: { type: 'hydration' } },
      { table: 'wellness_events', op: UpdateType.PUT, id: 'b', opData: { type: 'movement' } },
    ]);
    request.mockImplementationOnce(async (_url, init) => {
      session = { ...session!, user: { id: 'user-2' }, access_token: 'token-2' } as Session;
      // Already-started requests still use user-1's token, never the new user.
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer token-1' });
      return new Response(null, { status: 204 });
    });
    await expect(connector.uploadData(database)).rejects.toBeInstanceOf(AccountChangedError);
    expect(request).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
  });

  it('retains REST authorization/validation failures instead of losing local writes', async () => {
    const { database, complete } = transaction([
      { table: 'wellness_events', op: UpdateType.PUT, id: 'a', opData: { type: 'hydration' } },
    ]);
    request.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(connector.uploadData(database)).rejects.toThrow('403');
    expect(complete).not.toHaveBeenCalled();
  });

  it('requires the initiating account for direct pet commands too', async () => {
    session = null;
    await expect(invokePetCommand(client, config, { action: 'ensure_pet' }, 'user-1', request))
      .rejects.toBeInstanceOf(AccountChangedError);
    expect(request).not.toHaveBeenCalled();
  });
});

describe('public configuration', () => {
  it('rejects privileged keys from browser configuration', () => {
    expect(validateConfig({ ...config, supabaseKey: 'sb_secret_do-not-bundle' })).toContain('Secret keys');
    const jwt = `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ role: 'service_role' }))}.signature`;
    expect(validateConfig({ ...config, supabaseKey: jwt })).toContain('Privileged JWTs');
  });

  it('allows HTTPS or loopback development URLs', () => {
    expect(validateConfig(config)).toBeNull();
    expect(validateConfig({ ...config, supabaseUrl: 'http://127.0.0.1:54321' })).toBeNull();
    expect(validateConfig({ ...config, supabaseUrl: 'http://remote.example.com' })).toContain('HTTPS');
  });
});
