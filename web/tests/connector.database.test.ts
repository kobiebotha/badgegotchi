import { describe, expect, it, vi } from 'vitest';
import { UserDatabaseOwner } from '../src/lib/databaseOwner';

function database() {
  return {
    disconnectAndClear: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

describe('account database lifetime', () => {
  it('shares a stable database across concurrent React remounts', async () => {
    const db = database();
    const create = vi.fn(async () => db);
    const owner = new UserDatabaseOwner(create, async () => undefined);
    const [first, second] = await Promise.all([owner.open('alice'), owner.open('alice')]);
    expect(first).toBe(second);
    expect(create).toHaveBeenCalledOnce();
    expect(db.close).not.toHaveBeenCalled();
  });

  it('clears and closes the old account before opening the next one', async () => {
    const calls: string[] = [];
    const oldDb = database();
    oldDb.disconnectAndClear.mockImplementation(async () => { calls.push('clear'); });
    oldDb.close.mockImplementation(async () => { calls.push('close'); });
    const owner = new UserDatabaseOwner(async (userId) => {
      calls.push(`open:${userId}`);
      return userId === 'alice' ? oldDb : database();
    }, async () => undefined);
    await owner.open('alice');
    await owner.open('bob');
    expect(calls).toEqual(['open:alice', 'clear', 'close', 'open:bob']);
  });

  it('waits for initialization when sign-out arrives during database startup', async () => {
    let finish!: (value: ReturnType<typeof database>) => void;
    const startup = new Promise<ReturnType<typeof database>>((resolve) => { finish = resolve; });
    const db = database();
    const owner = new UserDatabaseOwner(async () => startup, async () => undefined);
    const opening = owner.open('alice');
    const clearing = owner.clear();
    finish(db);
    await Promise.all([opening, clearing]);
    expect(db.disconnectAndClear).toHaveBeenCalledOnce();
    expect(db.close).toHaveBeenCalledOnce();
  });

  it('clears a newly initialized handle if its identity changed during startup', async () => {
    const db = database();
    let userId = 'alice';
    const owner = new UserDatabaseOwner(async () => {
      userId = 'bob';
      return db;
    }, async (expected) => {
      if (userId !== expected) throw new Error('Account changed');
    });
    await expect(owner.open('alice')).rejects.toThrow('Account changed');
    expect(db.disconnectAndClear).toHaveBeenCalledOnce();
    expect(db.close).toHaveBeenCalledOnce();
  });

  it('fails closed after cleanup failure, and permits explicit cleanup retry', async () => {
    const db = database();
    db.disconnectAndClear.mockRejectedValueOnce(new Error('Storage unavailable'));
    const create = vi.fn(async () => db);
    const owner = new UserDatabaseOwner(create, async () => undefined);
    await owner.open('alice');
    await expect(owner.clear()).rejects.toThrow('Storage unavailable');
    await expect(owner.open('bob')).rejects.toThrow('previous account');
    expect(create).toHaveBeenCalledOnce();
    expect(db.close).not.toHaveBeenCalled();
    await owner.clear();
    await owner.open('bob');
    expect(create).toHaveBeenCalledTimes(2);
  });
});
