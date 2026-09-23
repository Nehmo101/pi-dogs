# pi-dogs architecture

pi-dogs lets the main pi agent start **dogs**: sub agents that are complete,
interactive pi sessions in their own Windows Terminal windows. The main pi
("hub") and each dog talk over a named pipe. This page explains the moving
parts; the wire format is specified in [protocol.md](protocol.md), the window
tiling in [window-backend.md](window-backend.md).

## Components

```
┌──────────────────────── main pi process ─────────────────────────┐
│ hub extension (src/hub/)                                         │
│  index.ts     registration: tools, /dogs, shortcuts, renderers   │
│  runtime.ts   session glue, UI, state carried across /reload     │
│  hub.ts       Hub core: spawn, lifecycle, results (pi-free)      │
│  registry.ts  records + state machine          server.ts  pipe   │
│  tools.ts / commands.ts / ui/ (dock, overlay) / models.ts / …    │
│  PaneBackend ── src/backend/windows-terminal/ (koffi, Win32)     │
└───────────────▲──────────────────────────────┬───────────────────┘
                │ JSONL over \\.\pipe\pi-dogs-<main pid>-<random>
                │                              │ wt.exe … -- node launcher.mjs launch.json
┌───────────────┴──────────── dog window ──────▼───────────────────┐
│ launcher.mjs → node <pi cli.js> --session … -e agent/index.ts …  │
│ agent extension (src/agent/)                                     │
│  index.ts    task injection, takeover, subagent_done, /done      │
│  client.ts   pipe client, reconnect, reliable done               │
│  forward.ts  batched/throttled event stream   summary.ts auto-done│
└──────────────────────────────────────────────────────────────────┘
```

- **Hub core (`Hub`)** has no pi imports. pi-specific actions go through a
  small `HubHost` interface (`sendToMain`, `notify`, `changed`) and windows
  through a `PaneBackend`. Integration tests run the real `Hub` against a
  `FakeBackend` and simulated agents over a real named pipe.
- **Agent extension** is loaded only into dogs (`-e`), never installed. The
  package manifest (`package.json` → `pi.extensions`) lists only the hub.
- **Launcher** is plain JavaScript so it runs anywhere without type stripping
  (Node does not strip types under `node_modules`).

## Starting a dog

1. The main agent calls `subagent({ task, context, … })` (or the user runs
   `/dogs new`).
2. `tools.ts` resolves the model *before* anything is opened: explicit
   `model` → `role` (session map, then `pi-dogs.json`) → session default
   (`/dogs model`, `subagent_config`) → `models.default` → the main agent's
   model. Patterns are checked against `ctx.modelRegistry.getAvailable()`;
   an unknown model is a tool error with suggestions.
3. `Hub.spawn` picks a unique dog name, derives the technical `agentId`,
   seeds the dog's session file (v3 header + a `custom_message` with the
   caller's context, or a copy of the main branch for `fork`), creates the
   dog's two secrets (the `token` it presents in `hello`, the `hubSecret`
   the hub echoes in `welcome`) and writes the launch file. The pi command
   line always settles project trust (`--approve` / `--no-approve`, see
   `dogProjectTrust`), so a dog never waits at pi's trust prompt.
4. The backend opens a window running `node launcher.mjs <launch.json>`.
   The launcher starts pi with inherited stdio: the same pi installation as
   the main pi (`process.execPath` + `process.argv[1]`), never through the
   `pi.cmd` shim.
5. In `session_start` the agent extension reads and deletes the launch file,
   connects and says `hello`. The hub answers `welcome` and `task`; the agent
   injects the task with `pi.sendUserMessage`.
6. The tool call returns immediately. Events flow to the dock and overlay.

## Finishing

- **`subagent_done({summary})`** (or `/done [summary]` typed by the user in
  the dog): the agent sends `done` (kept until acknowledged), the hub
  delivers the result to the main agent with
  `pi.sendMessage({customType: "pi-dogs-result", …}, {triggerTurn: true, deliverAs: "followUp"})`
  and acknowledges; with `closeOnDone` the dog quits and its window closes.
- **Auto-done.** An autonomous dog whose run settles (`agent_settled`)
  without calling the tool reports its last assistant message. It does not
  auto-finish if the user took it over, if the run was aborted, or in
  interactive mode. A model/provider error is reported as an error result.
- **Takeover.** Typing a prompt or `!command` into the dog's window (pi's
  `input` event with `source: "interactive"`, or `user_bash`) marks it
  `takenOver`; the main agent gets a note (without a new turn) that it
  should not wait for that dog.

The result message names the dog, model, token usage and cost, run time,
and the session file (so a dog can be resumed with `pi --session <file>`).

## Robustness

| Situation | What happens |
|---|---|
| Dog never connects | After `helloTimeoutMs` (30 s) it is `failed`; the window stays open for diagnosis. |
| pi crashes in a dog | The pipe drops without `done`; the launcher's exit file shows the exit code → `failed`, reported with the session file. |
| User closes a dog window | The backend reports the window gone and the hub records `windowClosed` on the dog; when pi is gone it is `killed` ("window closed"), whatever exit code pi got from the closing console (typically `0xC000013A`). Only a crash exit file written *before* the window vanished still counts as `failed`. |
| A dog is killed while it reports | A `done` that crosses the `shutdown` is acknowledged, but the kill wins: `killed`, reported as the kill asked (`subagent_kill` and quit: no report; `/dogs kill`: report without a turn). |
| `/reload`, `/new`, `/resume`, `/fork` inside a dog | The dog's extension runtime is re-created in the same process; connection and state move to the next runtime via `globalThis`, and `bye` is sent only on a real quit. |
| User quits a dog with `/quit` | `bye` without `done` → `killed` ("closed by the user"). |
| `/reload`, `/new`, `/resume` in the main pi | `session_shutdown` with a reason other than `quit`: the hub snapshots its registry into `globalThis` (module state does not survive a reload), closes the pipe **without** stopping dogs, and the next runtime re-listens on the same pipe name. Dogs reconnect with their token; a `done` sent in between is re-sent and delivered. The window backend instance is also carried over (it owns native window handles); window closes in the gap are buffered and replayed to the new hub. An in-flight kill is resumed with its report settings (they live on the dog's record), and the old runtime ignores everything once stopped. After `/new` or `/resume` results of older dogs arrive without triggering a turn, marked as coming from an earlier session. |
| Main pi quits | `session_shutdown{reason: "quit"}` is awaited: every dog (also a finished one still open with `closeOnDone: false`) gets `shutdown`, the hub waits `quitGraceMs`, then kills the dog's pi (`taskkill /PID <pid from hello> /T /F`). Killing pi rather than the launcher lets the launcher record the exit and close its window with code 0. |
| Main pi window closed hard | No `session_shutdown`. Dogs lose the pipe, retry for `hubGoneGraceMs`, then quit (or stay open when `killChildrenOnExit` is false). |
| Connection hangs | Hub pings every 5 s and drops connections silent for 15 s; the agent does the same and reconnects. |

## Model and session defaults

- Dog sessions are created next to the main session (`getSessionDir()`), so
  `/resume` in the project lists them. For an in-memory main session
  (`--no-session`) they go to `<agent-dir>/sessions/pi-dogs/`.
- The dog's pi is started with `--name <dog name>`, which makes pi's own
  terminal title "π - <dog name> - <folder>". The Windows Terminal backend
  launches windows with `--title … --suppressApplicationTitle`, so pi's title
  never replaces the unique tab title used to find the window.
- pi settings that must match the main pi (`PI_CODING_AGENT_DIR`,
  `PI_CODING_AGENT_SESSION_DIR`, `PI_PACKAGE_DIR`, `PI_OFFLINE`,
  `PI_SKIP_VERSION_CHECK`) travel in the launch file, because terminal
  windows do not necessarily inherit the main pi's environment.

## UI

- **Dock** (`ui/dock.ts`): a widget component above the editor, one line per
  dog (colour dot, name, model, state, current tool, elapsed time, tokens,
  `◉` for unseen output of minimized dogs). It is a component, not a string
  array, so it is not limited to 10 lines. Updates are coalesced (≤ 10/s)
  and pi renders differentially.
- **Mirror overlay** (`ui/overlay.ts`): `ctx.ui.custom(…, {overlay: true})`
  with a live view of one dog and a pi-tui `Input` for steering. View mode:
  Tab/Shift+Tab next/previous dog, Enter steer, R restore, M minimize, K kill
  (twice), arrows/PgUp/PgDn scroll, Esc close. Steer mode: Enter sends, Esc
  goes back.
- **Shortcuts.** pi reserves Ctrl+L for its model selector and extensions
  cannot override reserved keys. pi-dogs registers Ctrl+L only when the
  user's keybindings free it (`/dogs setup-keys` does that, with
  confirmation), and always registers the fallback Alt+M.

## Configuration

`<agent-dir>/pi-dogs.json` (agent dir: `~/.pi/agent` or
`$PI_CODING_AGENT_DIR`). All defaults live in `src/hub/config.ts`; invalid
values produce a warning and fall back to the default. See the README for
the table of settings.

## Testing

| Suite | Command | What it covers |
|---|---|---|
| Unit | `npm test` | Pure modules: framing, registry state machine, dog names, model resolution, config and keybindings merge, launch/exit files and the launcher script, event forwarding, auto-done, seeding, layout. |
| Integration | `npm test` | Real named pipe: `Hub` + `FakeBackend` + simulated agents (real `AgentClient`): lifecycle, auth, steering, takeover, crash, closed window, reload/reconnect with reliable `done`, quit sequencing, ping timeout. |
| End to end | `npm run test:e2e` | Real main pi in RPC mode with the hub, real dogs in Windows Terminal windows with a local model: two dogs report results, an interactive dog is steered and killed, quit cleans up. |
