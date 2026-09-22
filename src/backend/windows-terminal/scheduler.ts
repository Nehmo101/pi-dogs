/**
 * Coalesces bursts of relayout requests into one run.
 *
 * `request()` arms a short timer; further requests within `delayMs` push it
 * back, but never beyond `maxDelayMs` after the first request, so a steady
 * stream of requests still gets serviced. Runs never overlap: requests that
 * arrive during a run are handled by one more run right after it. Every
 * returned promise settles when a run that started after the request has
 * finished (and rejects if that run threw).
 */

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

const defaultTimers: Timers = {
  // Not unref()ed: callers await these runs, so they must keep the process alive.
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

interface Waiter {
  resolve(): void;
  reject(error: unknown): void;
}

export class CoalescingScheduler {
  readonly #task: () => Promise<void> | void;
  readonly #delayMs: number;
  readonly #maxDelayMs: number;
  readonly #timers: Timers;
  #waiting: Waiter[] = [];
  #timer: unknown;
  #firstRequestAt = 0;
  #running = false;
  #disposed = false;

  constructor(
    task: () => Promise<void> | void,
    options: { delayMs: number; maxDelayMs: number; timers?: Timers },
  ) {
    if (!(options.delayMs >= 0 && options.maxDelayMs >= options.delayMs)) {
      throw new RangeError("need 0 <= delayMs <= maxDelayMs");
    }
    this.#task = task;
    this.#delayMs = options.delayMs;
    this.#maxDelayMs = options.maxDelayMs;
    this.#timers = options.timers ?? defaultTimers;
  }

  /** Ask for a run soon. */
  request(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.#waiting.push({ resolve, reject });
      if (!this.#running) this.#arm(this.#delayMs);
    });
  }

  /** Ask for a run as soon as possible (still after a run in progress). */
  flush(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.#waiting.push({ resolve, reject });
      if (!this.#running) this.#arm(0);
    });
  }

  get pending(): boolean {
    return this.#waiting.length > 0 || this.#running;
  }

  /** Cancel the pending run; waiting promises resolve without a run. */
  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== undefined) this.#timers.clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const w of this.#waiting.splice(0)) w.resolve();
  }

  #arm(delay: number): void {
    const now = this.#timers.now();
    if (this.#timer === undefined) this.#firstRequestAt = now;
    else this.#timers.clearTimeout(this.#timer);
    const wait = Math.max(0, Math.min(delay, this.#firstRequestAt + this.#maxDelayMs - now));
    this.#timer = this.#timers.setTimeout(() => void this.#fire(), wait);
  }

  async #fire(): Promise<void> {
    this.#timer = undefined;
    if (this.#disposed || this.#running) return;
    const batch = this.#waiting.splice(0);
    if (batch.length === 0) return;
    this.#running = true;
    try {
      await this.#task();
      for (const w of batch) w.resolve();
    } catch (error) {
      for (const w of batch) w.reject(error);
    } finally {
      this.#running = false;
      if (this.#waiting.length > 0 && !this.#disposed) this.#arm(0);
    }
  }
}
