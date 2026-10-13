export type SkillQueueResult<T> =
  | { status: 'completed'; result: T }
  | { status: 'cancelled' }
  | { status: 'failed'; error: unknown };

interface QueueEntry<Job, Result> {
  key: string;
  job: Job;
  run: (job: Job, signal: AbortSignal) => Promise<Result>;
  resolve: (result: SkillQueueResult<Result>) => void;
}

/** One background reviewer per app, with explicit foreground ownership. */
export class SkillLearningQueue<Job, Result> {
  private foregroundCount = 0;
  private foregroundByKey = new Map<string, number>();
  private pending = new Map<string, QueueEntry<Job, Result>>();
  private active: { entry: QueueEntry<Job, Result>; controller: AbortController } | null = null;

  get foregroundActive(): boolean { return this.foregroundCount > 0 || this.foregroundByKey.size > 0; }

  cancel(key?: string): void {
    for (const [pendingKey, entry] of this.pending) {
      if (key !== undefined && key !== pendingKey) continue;
      this.pending.delete(pendingKey);
      entry.resolve({ status: 'cancelled' });
    }
    if (this.active && (key === undefined || this.active.entry.key === key)) this.active.controller.abort();
  }

  foregroundStarted(key?: string): () => void {
    if (key === undefined) this.foregroundCount += 1;
    else this.foregroundByKey.set(key, (this.foregroundByKey.get(key) ?? 0) + 1);
    if (this.active && (key === undefined || key === this.active.entry.key)) this.active.controller.abort();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (key === undefined) this.foregroundCount -= 1;
      else {
        const count = this.foregroundByKey.get(key)! - 1;
        if (count) this.foregroundByKey.set(key, count);
        else this.foregroundByKey.delete(key);
      }
      this.drain();
    };
  }

  enqueue(key: string, job: Job, run: QueueEntry<Job, Result>['run']): Promise<SkillQueueResult<Result>> {
    const promise = new Promise<SkillQueueResult<Result>>((resolve) => {
      this.pending.get(key)?.resolve({ status: 'cancelled' });
      this.pending.set(key, { key, job, run, resolve });
    });
    queueMicrotask(() => this.drain());
    return promise;
  }

  private drain(): void {
    if (this.foregroundCount || this.active) return;
    const entry = [...this.pending.values()].find((candidate) => !this.foregroundByKey.has(candidate.key));
    if (!entry) return;
    this.pending.delete(entry.key);
    const controller = new AbortController();
    this.active = { entry, controller };
    void Promise.resolve().then(() => {
      // Foreground/cancel may win after reservation but before this dispatch.
      if (controller.signal.aborted) throw new Error('SKILL_REVIEW_CANCELLED');
      return entry.run(entry.job, controller.signal);
    }).then(
      (result) => entry.resolve({ status: 'completed', result }),
      (error) => entry.resolve(controller.signal.aborted
        ? { status: 'cancelled' }
        : { status: 'failed', error }),
    ).finally(() => {
      this.active = null;
      this.drain();
    });
  }
}
