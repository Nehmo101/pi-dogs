/**
 * In-memory PaneBackend for tests. Records every call; `open()` hands the
 * spec to `onOpen`, which a test uses to start a simulated agent (or, for
 * end-to-end runs, the real launcher in a child process).
 */
import type { BackendEvents, OpenSpec, PaneBackend, PaneRef } from "../../src/backend/pane-backend.ts";

export class FakeBackend implements PaneBackend {
  readonly name = "fake";
  readonly calls: { method: string; agentId?: string }[] = [];
  readonly opened: OpenSpec[] = [];
  events: BackendEvents = {};
  availability: { ok: true } | { ok: false; hint: string } = { ok: true };
  failOpen: Error | undefined;
  onOpen: ((spec: OpenSpec) => void | Promise<void>) | undefined;

  constructor(onOpen?: (spec: OpenSpec) => void | Promise<void>) {
    this.onOpen = onOpen;
  }

  available() {
    return this.availability;
  }

  async open(spec: OpenSpec): Promise<PaneRef> {
    this.calls.push({ method: "open", agentId: spec.agentId });
    if (this.failOpen) throw this.failOpen;
    this.opened.push(spec);
    await this.onOpen?.(spec);
    return { agentId: spec.agentId };
  }

  async minimize(ref: PaneRef) {
    this.calls.push({ method: "minimize", agentId: ref.agentId });
  }

  async restore(ref: PaneRef) {
    this.calls.push({ method: "restore", agentId: ref.agentId });
  }

  async focus(ref: PaneRef) {
    this.calls.push({ method: "focus", agentId: ref.agentId });
  }

  async close(ref: PaneRef) {
    this.calls.push({ method: "close", agentId: ref.agentId });
  }

  async relayout() {
    this.calls.push({ method: "relayout" });
  }

  setEvents(events: BackendEvents) {
    this.events = events;
  }

  dispose() {
    this.calls.push({ method: "dispose" });
  }

  /** Simulate the user closing a window. */
  closeWindow(agentId: string) {
    this.events.onClosed?.({ agentId });
  }

  count(method: string, agentId?: string) {
    return this.calls.filter((c) => c.method === method && (agentId === undefined || c.agentId === agentId)).length;
  }
}
