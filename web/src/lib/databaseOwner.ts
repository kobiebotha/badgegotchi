export interface ManagedDatabase {
  disconnectAndClear(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Module-owned databases survive React's development remounts. All account
 * changes and cleanup are serialized, including sign-out during initialization.
 */
export class UserDatabaseOwner<T extends ManagedDatabase> {
  private active: { userId: string; database: T } | null = null;
  private pending: Promise<unknown> = Promise.resolve();
  private clearError: unknown;

  constructor(
    private readonly create: (userId: string) => Promise<T>,
    private readonly authorize: (userId: string) => Promise<void>,
    private readonly activate: (
      database: T,
      userId: string,
    ) => Promise<void> = async () => undefined,
  ) {}

  open(userId: string): Promise<T> {
    return this.run(async () => {
      if (this.clearError) {
        throw new Error(
          "The previous account could not be cleared. Retry signing out before opening another account.",
          {
            cause: this.clearError,
          },
        );
      }
      await this.authorize(userId);
      if (this.active?.userId === userId) return this.active.database;
      await this.clearActive();
      const database = await this.create(userId);
      this.active = { userId, database };
      try {
        // The identity can change while the SQLite worker starts up.
        await this.authorize(userId);
        await this.activate(database, userId);
        await this.authorize(userId);
      } catch (error) {
        await this.clearActive();
        throw error;
      }
      return database;
    });
  }

  clear(): Promise<void> {
    return this.run(() => this.clearActive());
  }

  private async clearActive(): Promise<void> {
    if (!this.active) return;
    try {
      await this.active.database.disconnectAndClear();
      await this.active.database.close();
      this.active = null;
      this.clearError = undefined;
    } catch (error) {
      // Fail closed: neither this identity nor another one may reuse a handle
      // whose cleanup failed. Keep it available only to retry cleanup.
      this.clearError = error;
      throw error;
    }
  }

  private run<R>(operation: () => Promise<R>): Promise<R> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }
}
