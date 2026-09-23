# pi-dogs protocol, version 1

This document is **normative** for the wire protocol between the hub (the
pi-dogs extension in the main pi) and an agent (the pi-dogs extension in a
dog's pi), and for the two files exchanged outside the pipe. The reference
implementation is `src/protocol/` (types, framing, launch and exit files),
`src/hub/server.ts` and `src/agent/client.ts`.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Transport

- **Windows:** a named pipe `\\.\pipe\pi-dogs-<pid>-<random>`, where
  `<pid>` is the process id of the main pi and `<random>` 16 hex digits
  chosen once per main pi process. The name is stable for the lifetime of
  that process, so the hub can re-listen on it after `/reload`, `/new` or
  `/resume` (these re-create the extension runtime).
- **Other platforms (reserved):** a Unix domain socket
  `<tmpdir>/pi-dogs-<pid>-<random>.sock`.
- The hub is the server; every agent opens exactly one connection.
- **Security.** The pipe is created with Node's default security
  descriptor. That default DACL does not stop other local accounts from
  opening the pipe for reading (it grants Everyone read access), and pipe
  names can be listed by anyone on the machine. The random suffix only
  makes the name hard to squat before the hub listens (for example while a
  `/reload` re-creates the server). Security relies on mutual secrets from
  the launch file (section 8), which only the user can read:
  - the hub accepts only a `hello` with the agent's `token`;
  - the agent accepts only a `welcome` (and a final `reject`) carrying its
    `hubSecret`, and ignores everything a peer sends before that.
  The agent does not verify the server's process id (Win32
  `GetNamedPipeServerProcessId` needs the raw pipe handle, which Node does
  not expose); the hub secret covers the same threat.

## 2. Framing

- One JSON object per line, UTF-8, terminated by LF (`\n`, 0x0A). A
  preceding CR is stripped, so CRLF input is accepted.
- Receivers MUST split on LF only. U+2028 and U+2029 are valid inside JSON
  strings and MUST NOT be treated as line breaks (so no Node `readline`).
- Blank lines are ignored.
- A line MUST NOT exceed 1 MiB (1,048,576 bytes, excluding the terminator).
  Senders MUST refuse to send longer lines; receivers report
  `LINE_TOO_LONG` and skip to the next line.
- Free text is capped well below that so a message always fits: a `task`
  or `steer` text whose JSON-encoded size exceeds 512 KiB is refused where
  it enters (the `subagent` / `subagent_steer` tools, `/dogs`), with an
  error that says so; a `done` summary longer than that is truncated by the
  agent and marked "… (truncated by pi-dogs)". Implementations MUST NOT let
  an encoding failure escape into pi (it would end the process).
- Invalid UTF-8, invalid JSON, a missing or wrong envelope, an unknown
  `type` or a wrong payload field type (including the fields of nested
  objects: `event`, `usage`, `config`) is a protocol error. The hub closes a
  connection on any protocol error. The agent ignores lines it cannot
  decode (the hub is authoritative).

## 3. Envelope

Every message has:

| Field | Type | Meaning |
|---|---|---|
| `v` | number | Protocol version. This document is version `1`. |
| `type` | string | Message type (section 5). |
| `agentId` | non-empty string | Technical id of the agent the message is about. |
| `id` | string, optional | Request id; echoed by replies that refer to it. |

Unknown extra fields MUST be ignored, which allows compatible additions
without a version bump. A message with an unsupported `v` is a protocol
error.

## 4. Connection lifecycle

```
agent                                   hub
  │ ── connect ──────────────────────────▶│
  │ ── hello {token, pid, protocol} ─────▶│  verify token (constant time)
  │ ◀── welcome {config, resumed, hubSecret}│  agent verifies hubSecret
  │ ◀──────────────────────── task {text} │  only if the task was not sent before
  │ ── status / event / takeover … ──────▶│
  │ ◀──────── steer / abort / shutdown … ─│
  │ ── done {id, summary, usage, …} ─────▶│
  │ ◀────────────────────── ack {ref: id} │
  │ ── bye {reason} ─────────────────────▶│  pi is shutting down
  │ ── close ───────────────────────────▶ │
```

1. The first message on a connection MUST be `hello`. The hub closes a
   connection that sends anything else first, or nothing within 10 s.
2. The hub accepts `hello` only if `agentId` is known, `token` matches the
   token from the agent's launch file, `protocol` is supported, and the agent
   is not in a terminal state other than `done`. Otherwise it answers
   `reject {reason}` and closes. When the token matched, the `reject`
   carries the agent's `hubSecret`: such a reject is final and the agent
   MUST NOT reconnect. A reject without a valid `hubSecret` (wrong token,
   unknown agent, or not our hub at all) is treated like a dropped
   connection: the agent keeps retrying until `hubGoneGraceMs`.
3. On acceptance the hub sends `welcome` with the agent's `hubSecret`. The
   agent MUST compare it (in constant time) with the one from its launch
   file and drop the connection on a mismatch. Until a verified `welcome`
   the agent ignores every other message. `resumed: true` means the hub
   already delivered the task (a reconnect); `resumed: false` is followed by
   exactly one `task`. The task is never sent twice for the same agent. An
   agent that reconnects while the hub is killing it receives `shutdown`
   right after `welcome` instead.
4. A newer accepted connection for the same agent replaces the old one; the
   hub closes the old connection.
5. After `welcome`, messages whose `agentId` differs from the one in `hello`
   are a protocol error.

### Keep-alive

- The hub sends `ping` to every connection every 5 s.
- The receiver of a `ping` MUST answer `pong`, echoing `id` if present.
- The hub closes a connection that sent nothing for 15 s. The agent treats
  a connection on which it received nothing for 15 s as lost.

### Reconnect

When the connection drops without a `shutdown`, the agent SHOULD reconnect
with backoff (reference: 100, 250, 500, 1000, then every 2000 ms) and send
`hello` with `reconnect: true`. If no connection could be established for
`hubGoneGraceMs` (from `welcome.config`, default 30 000 ms), the agent
assumes the hub is gone and quits. `hubGoneGraceMs: 0` means "never give up;
stay open for manual use" (used when `killChildrenOnExit` is false).

After a reconnect the agent SHOULD send a fresh `status`, because the hub
may have been re-created and lost live state, and MUST repeat `takeover` if
it was taken over (a `takeover` sent while disconnected is lost).

`/reload`, `/new`, `/resume` and `/fork` typed inside a dog re-create the
dog's extension runtime in the same process. The connection and the dog's
state MUST survive that (the launch file is already deleted); `bye` is sent
only when pi really quits (shutdown reason `quit`).

A dog whose pipe dropped while its pi process still looks alive has 60 s to
reconnect; after that the hub reports it as `failed` (the process id may
have been reused by another process).

## 5. Messages

### Agent → hub

| `type` | Payload | Meaning |
|---|---|---|
| `hello` | `token: string`, `pid: number` (pi process id), `piVersion: string`, `protocol: number` (highest supported), `reconnect?: boolean` | Log in. |
| `status` | `state: AgentState`, `tool?: string`, `usage: Usage`, `model: string` | Current state; senders SHOULD send at most ~4 per second. `usage` is cumulative. |
| `event` | `event: AgentEvent` | Filtered pi events for the mirror view (below). |
| `takeover` | – | A human typed into the dog's window (prompt or `!command`). Sent once per connection; the hub ignores repeats. |
| `done` | `summary: string`, `usage: Usage`, `sessionFile: string`, `error?: string`; SHOULD carry `id` | The agent finished. `error` is set when the run ended with a model or provider error. |
| `bye` | `reason: string` | pi is shutting down; `reason` is pi's shutdown reason (`quit`, …). |
| `error` | `message: string`, `fatal: boolean` | A problem the hub should show. |
| `ping` / `pong` | – | Keep-alive. |

### Hub → agent

| `type` | Payload | Meaning |
|---|---|---|
| `welcome` | `config: AgentConfig`, `resumed: boolean`, `hubSecret: string` | Login accepted; `hubSecret` proves it is the agent's own hub. |
| `reject` | `reason: string`, `hubSecret?: string` | Login refused; the hub closes the connection. Final only with a valid `hubSecret`. |
| `task` | `text: string` | The task. Sent once, right after the first `welcome`. |
| `steer` | `text: string`, `mode: "steer" \| "followUp"` | A message for the running agent. `steer` is delivered at the next turn boundary, `followUp` after the agent would otherwise stop. |
| `abort` | `reason: string` | Abort the current turn. |
| `shutdown` | – | Quit now. The agent aborts a running turn and exits. |
| `ack` | `ref: string` | Acknowledges the message whose `id` is `ref` (currently `done`). |
| `ping` / `pong` | – | Keep-alive. |

### Types

```ts
type AgentState = "starting" | "running" | "idle" | "closing" | "done" | "failed" | "killed";

interface Usage { input: number; output: number; cacheRead?: number; cacheWrite?: number; cost?: number /* USD */ }

interface AgentConfig {
  mode: "autonomous" | "interactive";
  closeOnDone: boolean;       // quit after `done` has been acknowledged
  hubGoneGraceMs: number;     // 0 = never quit because the hub is gone
  name: string;               // display name
}

type AgentEvent =
  | { kind: "text_delta"; text: string }                                   // batched assistant text
  | { kind: "tool_start"; toolCallId: string; tool: string; args?: string } // args: short summary
  | { kind: "tool_end"; toolCallId: string; tool: string; isError: boolean }
  | { kind: "user_message"; text: string; source: "hub" | "user" };        // task/steer or typed input
```

## 6. Delivery rules

- **Injection.** An agent MUST inject `task` and `steer` so they are never
  lost: while idle as a plain user message, while busy queued as `steer` or
  `followUp` (pi rejects an unqueued message while busy).
- **Tasks are not command-line arguments.** The task reaches pi only through
  `task`; a task passed on pi's command line would look like typed input and
  trigger a false takeover.
- **Reliable `done`.** The agent keeps a sent `done` until it receives the
  matching `ack`, and re-sends it after every reconnect. The hub MUST
  acknowledge every `done` that carries an `id`, including duplicates, and
  MUST report a result to the main agent only once.
- **Closing.** After `done` the agent is `closing`: it MUST NOT start new
  work and answers `steer` with a non-fatal `error`. The hub MUST NOT send
  `task` or `steer` to an agent in `closing` or a terminal state.
- **closeOnDone.** With `closeOnDone: true` the agent quits once `done` is
  acknowledged. With `false` it stays open in state `done`.
- **Shutdown.** On `shutdown` the agent aborts a running turn and quits.
  It SHOULD send `bye` before closing. After `shutdown` (and for a run the
  hub ended with `abort`) the agent MUST NOT send an automatic `done`. If a
  `done` still crosses the `shutdown`, the hub acknowledges it but the kill
  wins: the dog ends `killed`, reported (or not) as the kill asked, and the
  summary is only attached to that report.
- **Quit.** When the main pi quits, the hub also sends `shutdown` to
  finished dogs that are still connected (`closeOnDone: false`).

## 7. Agent states (hub registry)

```
starting ──hello/task──▶ running ◀──────▶ idle
    │                      │  │             │
    │ hello timeout,       │  └──done──▶ closing ──process gone──▶ done
    │ window closed        │                │
    ▼                      ├──kill─────▶ closing ──process gone──▶ killed
  failed ◀── crash (pipe lost without done, exit file code ≠ 0) ──┘
```

| From | Allowed next states |
|---|---|
| `starting` | `running`, `idle`, `closing`, `failed`, `killed` |
| `running`, `idle` | each other, `closing`, `done`, `failed`, `killed` |
| `closing` | `done`, `failed`, `killed` |
| `done`, `failed`, `killed` | none (terminal) |

Flags independent of the state: `minimized`, `takenOver`, `unseen` (new
output while minimized), `connected`.

How the hub decides the end state when a connection is lost without `done`
(`src/hub/hub.ts`, `#watchExit`):

| Evidence | Result |
|---|---|
| Agent was `closing` (after `done` or `kill`) | the planned state (`done` or `killed`) |
| The backend reported the window closed (and no crash exit file was there before), or exit code `0xC000013A` (console closed) | `killed` ("window closed") |
| Exit file with code ≠ 0, a signal, or a start error | `failed` ("pi crashed") |
| Exit file with code 0 | `failed` ("exited without reporting a result") |
| `bye` without prior `done` | `killed` ("closed by the user") |
| pi process gone and no exit file after a grace period | `killed` ("window closed") |
| pi process still alive | wait: the agent is reconnecting (at most 60 s, then `failed`) |

## 8. Launch file

Written by the hub to `<tmp>/pi-dogs/<hub pid>/<agentId>/launch.json`
before the window opens. The launcher reads it (and does not delete it);
the agent extension reads it in `session_start` and MUST delete it
immediately, because it contains the secrets (`token` and `hubSecret`,
both valid for the agent's lifetime). An agent started with
`--pi-dogs-launch` whose launch file is missing quits: it can never connect
(typically the hub gave up on it already). Passed to pi as
`--pi-dogs-launch=<path>` (the `=` form is required: pi's parser would
otherwise not accept a path that starts with `-`).

```json
{
  "v": 1,
  "agentId": "bello-baggins-3f2a",
  "name": "Bello Baggins",
  "pipe": "\\\\.\\pipe\\pi-dogs-4242-9f2c4d1e8a7b6c50",
  "token": "<24 random bytes, base64url>",
  "hubSecret": "<24 random bytes, base64url>",
  "cwd": "C:\\work\\project",
  "exitFile": "C:\\…\\pi-dogs\\4242\\bello-baggins-3f2a\\exit.json",
  "pi": { "command": "C:\\Program Files\\nodejs\\node.exe", "args": ["…\\cli.js", "--session", "…", "-e", "…\\agent\\index.ts", "--pi-dogs-launch=…", "--name", "Bello Baggins", "--model", "ollama/qwen3.5:4b"] },
  "env": { "PI_DOGS_AGENT_ID": "bello-baggins-3f2a", "PI_CODING_AGENT_DIR": "…" }
}
```

- `pi.command` + `pi.args` is the complete command line. A bare `"pi"`
  command is resolved by the launcher (on Windows: the npm shim's package,
  run with node, to avoid `cmd.exe`).
- `env` is added to the launcher's environment. `PI_DOGS_AGENT_ID` marks a
  dog's pi; the hub extension stays inactive when it is set (no nested dogs
  in v1).

## 9. Exit file

Written by the launcher when pi ends. The launcher itself MUST always exit
with code 0: Windows Terminal keeps a window open after a non-zero exit.

```json
{ "code": 1, "signal": null, "endedAt": "2026-09-23T10:00:00.000Z", "error": "optional: pi could not be started" }
```

## 10. Versioning

- `v` is incremented only for incompatible changes. New optional fields are
  compatible and keep `v: 1`. New message types and new event kinds are not:
  receivers validate them strictly (an unknown type or kind is a protocol
  error), so they need a new version.
- `hello.protocol` states the highest version the agent speaks; the hub
  rejects versions it does not support.
