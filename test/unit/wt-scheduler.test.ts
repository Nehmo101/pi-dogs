import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CoalescingScheduler, type Timers } from "../../src/backend/windows-terminal/scheduler.ts";

/** Manual clock: timers fire only when `advance` passes their due time. */
class FakeTimers implements Timers {
  time = 0;
  #timers = new Map<number, { due: number; fn: () => void }>();
  #id = 0;
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.#id;
    this.#timers.set(id, { due: this.time + ms, fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }
  now(): number {
    return this.time;
  }
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      const next = [...this.#timers.entries()].sort((a, b) => a[1].due - b[1].due)[0];
      if (!next || next[1].due > end) break;
      this.time = next[1].due;
      this.#timers.delete(next[0]);
      next[1].fn();
      await flushMicrotasks();
    }
    this.time = end;
    await flushMicrotasks();
  }
}

const flushMicrotasks = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function setup(task: () => Promise<void> | void = () => {}) {
  const timers = new FakeTimers();
  let runs = 0;
  const scheduler = new CoalescingScheduler(
    async () => {
      runs++;
      await task();
    },
    { delayMs: 30, maxDelayMs: 200, timers },
  );
  return { timers, scheduler, runs: () => runs };
}

describe("CoalescingScheduler", () => {
  it("coalesces a burst into one run after the quiet time", async () => {
    const { timers, scheduler, runs } = setup();
    const done = [scheduler.request(), scheduler.request(), scheduler.request()];
    await timers.advance(29);
    assert.equal(runs(), 0);
    await timers.advance(1);
    await Promise.all(done);
    assert.equal(runs(), 1);
  });

  it("pushes the run back while requests keep coming, but not beyond maxDelay", async () => {
    const { timers, scheduler, runs } = setup();
    for (let t = 0; t < 300; t += 20) {
      void scheduler.request();
      await timers.advance(20);
    }
    // Requests every 20 ms (< 30 ms quiet time): runs happen every 200 ms anyway.
    assert.equal(runs(), 1);
    await timers.advance(200);
    assert.equal(runs(), 2);
  });

  it("never overlaps runs and serves requests made during a run", async () => {
    let release!: () => void;
    let active = 0;
    let maxActive = 0;
    const { timers, scheduler, runs } = setup(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((r) => (release = r));
      active--;
    });
    const first = scheduler.request();
    await timers.advance(30);
    assert.equal(runs(), 1);
    const second = scheduler.request(); // during the run
    await timers.advance(100);
    assert.equal(runs(), 1, "waits for the running task");
    release();
    await first;
    await timers.advance(0);
    assert.equal(runs(), 2);
    release();
    await second;
    assert.equal(maxActive, 1);
  });

  it("flush() runs without the quiet time", async () => {
    const { timers, scheduler, runs } = setup();
    const done = scheduler.flush();
    await timers.advance(0);
    await done;
    assert.equal(runs(), 1);
  });

  it("rejects the waiting callers when the run throws, and keeps working", async () => {
    let fail = true;
    const { timers, scheduler } = setup(() => {
      if (fail) throw new Error("boom");
    });
    const p = scheduler.request();
    await timers.advance(30);
    await assert.rejects(p, /boom/);
    fail = false;
    const q = scheduler.request();
    await timers.advance(30);
    await q;
  });

  it("dispose() resolves waiters without running", async () => {
    const { timers, scheduler, runs } = setup();
    const p = scheduler.request();
    scheduler.dispose();
    await p;
    await timers.advance(100);
    assert.equal(runs(), 0);
    await scheduler.request();
    assert.equal(scheduler.pending, false);
  });

  it("validates its options", () => {
    assert.throws(() => new CoalescingScheduler(() => {}, { delayMs: 50, maxDelayMs: 10 }), RangeError);
  });
});
