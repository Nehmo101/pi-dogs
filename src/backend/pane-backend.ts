/**
 * Contract between the hub and whatever shows agent windows on screen.
 *
 * v1 ships one implementation: WindowsTerminalBackend (one Windows Terminal
 * window per agent, tiled via Win32; see docs/spike/layout.md). Tests use a
 * fake backend. Other terminals (tmux, WezTerm, a future "Deck" app) can be
 * added by implementing this interface.
 */

/** What the hub asks a backend to open for one agent. */
export interface OpenSpec {
  /** Technical agent id (stable, filename- and title-safe). */
  agentId: string;
  /** Display name, e.g. "Bello Baggins". */
  name: string;
  /** Model label shown in the title, e.g. "qwen3.5:4b". */
  modelLabel: string;
  /** Tab/accent colour as #rrggbb. */
  color: string;
  /** Working directory for the agent process. */
  cwd: string;
  /** Executable and arguments to run inside the window (the launcher). */
  command: string;
  args: string[];
}

/** Opaque handle to an opened agent window. */
export interface PaneRef {
  agentId: string;
}

export interface BackendEvents {
  /** The window disappeared (closed by the user or its process exited). */
  onClosed?(ref: PaneRef): void;
}

export interface PaneBackend {
  /** Human-readable backend name, e.g. "windows-terminal". */
  readonly name: string;

  /** Whether this backend can run in the current environment, with a hint if not. */
  available(): { ok: true } | { ok: false; hint: string };

  /** Open a window for an agent and place it according to the current layout. */
  open(spec: OpenSpec): Promise<PaneRef>;

  /** Minimize the agent window; the agent keeps running. */
  minimize(ref: PaneRef): Promise<void>;

  /** Restore a minimized agent window to its layout slot without stealing focus. */
  restore(ref: PaneRef): Promise<void>;

  /** Bring the agent window to the foreground (user asked to look at it). */
  focus(ref: PaneRef): Promise<void>;

  /** Close the window if it is still open (the process is stopped by the hub separately). */
  close(ref: PaneRef): Promise<void>;

  /** Re-apply the layout, e.g. after the work area or the set of visible agents changed. */
  relayout(): Promise<void>;

  /** Subscribe to backend events. */
  setEvents(events: BackendEvents): void;

  /** Release resources (timers, native handles). Idempotent. */
  dispose(): void;
}
