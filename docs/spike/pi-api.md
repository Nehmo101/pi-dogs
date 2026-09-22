# Spike: Pi extension API (Phase 0)

Pi coding agent **0.87.1** (`@earendil-works/pi-coding-agent`), Windows 11, Node 24.19, Windows Terminal 1.24, local model `ollama/qwen3.5:4b` (`--thinking off`).
Date: 2026-09-23.

All proofs live in `spike/pi-api/`. Paths inside the scripts are relative to the script location.

| File | Purpose |
|---|---|
| `hub.ts` | Parent side: named-pipe server started in `session_start` and closed in `session_shutdown`. It turns pipe `result` messages into `pi.sendMessage(..., {triggerTurn})`. |
| `hub-driver.mjs` | Runs the main Pi in **RPC mode** with `hub.ts`, connects to the pipe the way a sub agent would, and checks idle and busy delivery plus pipe teardown. |
| `agent.ts` | Child side: `--pi-dogs-launch` flag, pipe client, event forwarding, injection, takeover detection, Ctrl+L, widget, overlay, `subagent_done`, shutdown. |
| `launch-child.mjs` | Stand-in for `launcher.mjs`. It sets the environment, starts interactive `pi` with inherited stdio, writes `<launch>.exit.json`, and always exits 0 (see Q7). |
| `child-driver.mjs` | Plays the hub. It opens the child in its own WT window (`wt -w pi-dogs-apispike new-tab …`) and runs one of three scenarios: `inject`, `remap` or `seed`. |
| `inject-keys.ps1` | Simulates a user typing in the child's terminal **without touching focus**: `AttachConsole(pid)` plus `WriteConsoleInput` into the ConPTY input buffer. |
| `events-probe.ts` | Logs every lifecycle event with a compact payload shape (print mode). |
| `tui-grep.mjs`, `list-wt-windows.ps1` | Strip ANSI from a `PI_TUI_WRITE_LOG` capture and search it. List WT window titles (read-only). |

The spike used an isolated agent dir (`PI_CODING_AGENT_DIR=spike/pi-api/agentdir`, which holds only `models.json`) so that `~/.pi/agent` stayed untouched. `agentdir-remap/` adds a `keybindings.json`. Logs are in `spike/pi-api/logs/`.

How to rerun: `node hub-driver.mjs`, `node child-driver.mjs inject`, `node child-driver.mjs remap agentdir-remap`, `node child-driver.mjs seed`.

---

## Q1 Named pipe and `registerFlag`

**Answer: works as planned.** The hub creates `net.createServer().listen("\\\\.\\pipe\\pi-dogs-…")` in `session_start` and closes it in `session_shutdown`. The child connects in its own `session_start` and exchanges JSONL.

```ts
// factory: registration only
pi.registerFlag("pi-dogs-launch", { description: "pi-dogs launch file", type: "string" });
pi.on("session_start", (e, ctx) => {
  const launchFile = pi.getFlag("pi-dogs-launch");     // string | boolean | undefined
  const launch = JSON.parse(readFileSync(launchFile, "utf8")); rmSync(launchFile);
  sock = net.connect(launch.pipe, () => send({ type: "hello", token: launch.token, pid: process.pid, protocol: 1 }));
});
```

- Signatures: `registerFlag(name, {type:"boolean"|"string", default?, description?})` and `getFlag(name): boolean | string | undefined`. `getFlag` only returns flags registered **by the same extension**. For any other name it returns `undefined`.
- **The value is not available in the factory.** A log from the factory showed `getFlag = undefined`. In `session_start` the value was the path. Read it in `session_start` or later.
- Parsing (`cli/args.js`): `--name=value` or `--name value`. In the `--name value` form, the next argument counts as the value **only if it does not start with `-` or `@`**. Unknown flags are collected first and checked against the registered flags after extensions load. A flag that no extension registers is rejected with "Unknown option". A string flag without a value is rejected with "requires a value". **Use `--pi-dogs-launch=<path>`** (unambiguous, safe for paths with spaces when quoted).
- Teardown verified: after the RPC Pi quit, `session_shutdown{reason:"quit"}` closed the server and connecting to the pipe returned `ENOENT`.
- Verified by running `hub-driver.mjs` (RPC parent) and `child-driver.mjs` (interactive child). Read `cli/args.js`, `core/agent-session-services.js` and `core/extensions/loader.js`.

Caveats:
- `session_shutdown` also fires with `reason: "reload" | "new" | "resume" | "fork"`, and `session_start` fires again afterwards with a **new extension runtime** (module state is gone). With a random pipe name per `session_start`, a `/reload` or `/new` in the main Pi would orphan every child. **Plan impact:** derive the pipe name from something stable (for example `pi-dogs-<main pi process.pid>`, or persist the hubId), re-listen on the same name after a reload, and make the agent reconnect with retries. Kill children only on `reason === "quit"`.
- `session_shutdown` handlers are awaited (`emitSessionShutdownEvent` awaits `emit`). An async handler can therefore send `shutdown` to the children and wait briefly for acknowledgements.
- Not tested: the pipe ACL. It is left for the protocol and security work.

## Q2 Injecting input (child TUI) and delivering results (parent)

### Child: `pi.sendUserMessage(content, { deliverAs?: "steer" | "followUp", expandPromptTemplates?: boolean }): void`

Verified in the interactive TUI, driven over the pipe:

| Situation | Call | Result |
|---|---|---|
| idle | `sendUserMessage(text)` | Starts a turn immediately. `input` fires with `source:"extension"`, then `agent_start`. |
| busy | `sendUserMessage(text)` **without** `deliverAs` | **Rejected.** The `input` handler still fires first. The runtime then throws "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp')…". The call is fire-and-forget (`void`), so the extension cannot catch the error; Pi shows it as an extension error in the TUI. The message is lost. |
| busy | `{deliverAs:"steer"}` | Queued (`ctx.hasPendingMessages() === true`). Delivered at the next turn boundary, after the current assistant message and its tool calls. `input.streamingBehavior === "steer"`. |
| busy | `{deliverAs:"followUp"}` | Queued and delivered only after the agent would otherwise stop. It runs as a further turn of the same run, and `agent_end` comes after it. |

Rule for the agent extension: `pi.sendUserMessage(text, ctx.isIdle() ? undefined : { deliverAs: mode ?? "steer" })`.
- `expandPromptTemplates` defaults to **false** for `sendUserMessage`. With `true`, a `/command` text is dispatched as an extension command.
- `pi.sendMessage({customType, content, display, details}, {triggerTurn:true})` also works in the child (a `custom` role message, which is rendered in the transcript). Verified idle.

### Parent: `pi.sendMessage(message, { triggerTurn?: boolean, deliverAs?: "steer" | "followUp" | "nextTurn" }): void`

Verified in RPC mode with `hub-driver.mjs`:

| Main agent state | Options | Result |
|---|---|---|
| idle | `triggerTurn:true` | A new run starts (`agent_start` → `message_start{role:"custom", customType:"pi-dogs-result"}` → model answer). |
| idle | `triggerTurn:false` | The message is appended to the session (`message_start/end`) without a turn. It enters the context of the next prompt. |
| busy | `triggerTurn:true, deliverAs:"followUp"` | Delivered after the current work, as another `turn_start` in the same run (no second `agent_start`). |
| busy | `triggerTurn:true` (default = steer) | Delivered at the next turn boundary as another turn of the same run. |
| any | `deliverAs:"nextTurn"` | Held until the next user prompt (not tested; read from `sendCustomMessage`). |

Source: `core/agent-session.js` (`sendCustomMessage`, `sendUserMessage`, `prompt`). While busy, `triggerTurn:false` defers the append until the turn ends so that tool-call/result order stays valid.

**Recommendation for `done`:** `pi.sendMessage({customType:"pi-dogs-result", content: summary, display:true, details:{agentId, usage, sessionFile}}, {triggerTurn:true, deliverAs:"followUp"})`. `followUp` avoids interrupting a running tool chain in the main agent. Register a message renderer for `pi-dogs-result` (`pi.registerMessageRenderer`) to get a compact look.

## Q3 Detecting manual typing (takeover)

**Answer: the `input` event distinguishes the two cases reliably through `event.source`.**

```ts
pi.on("input", (e) => {           // InputEvent {text, images?, source, streamingBehavior?}
  if (e.source === "interactive") send({ type: "takeover" });
  return { action: "continue" };   // or {action:"transform", text} / {action:"handled"}
});
```

| Origin | `source` | Verified |
|---|---|---|
| User types and presses Enter in the TUI (idle) | `"interactive"` | Yes (injected keystrokes). `streamingBehavior` is undefined. |
| User types while the agent streams (Enter = steer) | `"interactive"`, `streamingBehavior:"steer"` | Yes. The TUI shows "Steering: …". |
| `pi.sendUserMessage` | `"extension"` | Yes |
| RPC `prompt` | `"rpc"` | Read in the source |
| **Initial message given on the CLI** (`pi "task"`) | `"interactive"` | Yes (print mode). **Never pass the task as a CLI argument, or it looks like a takeover.** Send it with `sendUserMessage` after `hello`, as the plan already does. |

What the `input` event does not show:
- `/command` input. Extension commands run before `input` fires (`_tryExecuteExtensionCommand`). Built-in slash commands are also not prompts.
- `!cmd` / `!!cmd`. These fire the separate `user_bash` event, and the spike also treats that as takeover.

For "user started typing" before Enter, `ctx.ui.onTerminalInput((data) => undefined)` receives every raw key chunk. It is TUI only, and returning `{consume:true}` swallows the key. In the test it saw every keystroke. **Caveat:** it also saw a stray `"e"` at startup, most likely part of a terminal protocol reply. It also fires for keys that go to overlays and selectors. Use it at most as a hint and use `input` with `source === "interactive"` as the takeover signal.

Keystroke simulation for tests: `inject-keys.ps1` (`AttachConsole` plus `WriteConsoleInput`) works against a pi inside Windows Terminal without focusing the window. This makes takeover and shortcut behaviour testable in CI-like scripts.

## Q4 Events for forwarding (verified payloads, `events-probe.jsonl`)

Order for one prompt with one tool call: `input` → `before_agent_start` → `agent_start` → `turn_start{turnIndex:0}` → `message_start/end{role:"system"}` (first request of a session) → `message_start/end{role:"user"}` → `message_start{role:"assistant"}` → `message_update`* → `message_end` → `tool_execution_start` → `tool_call` → `tool_execution_update`* → `tool_result` → `tool_execution_end` → `message_start/end{role:"toolResult"}` → `turn_end` → `turn_start{1}` → … → `agent_end{messages}` → `agent_before_settle{outcome}` → `agent_settled` → (on quit) `session_shutdown{reason:"quit"}`.

| Need | Event | Payload |
|---|---|---|
| text deltas | `message_update` | `{message, assistantMessageEvent}`. `assistantMessageEvent.type` ∈ `start`, `text_start`, `text_delta{contentIndex, delta}`, `text_end{content}`, `thinking_start/_delta/_end`, `toolcall_start`, `toolcall_delta`, `toolcall_end{toolCall}`, `done`, `error`. Every sub-event also carries a `partial` AssistantMessage, which is large. |
| tool start | `tool_execution_start` | `{toolCallId, toolName, args}` |
| tool progress | `tool_execution_update` | `{toolCallId, toolName, args, partialResult:{content, details}}` |
| tool end | `tool_execution_end` | `{toolCallId, toolName, result:{content, details}, isError}` |
| usage | `message_end` (role `assistant`) | `message.usage = {input, output, cacheRead, cacheWrite, reasoning, totalTokens, cost:{input, output, cacheRead, cacheWrite, total}}`, plus `message.stopReason` ("stop", "toolUse", "error", "aborted") and `errorMessage`. |
| state | `agent_start {}`, `agent_end {messages}`, `agent_settled {}`, `turn_start {turnIndex, timestamp}`, `turn_end {turnIndex, message, toolResults, …}` | Use `agent_settled` for the "idle" state. It is the only one after which Pi will not continue automatically (retries, compaction, queued steer/followUp). `ctx.isIdle()` is already `true` there. |
| model change | `model_select {model, previousModel, source}` | |
| blocked on a UI prompt | `ui_prompt_start` / `ui_prompt_end {kind, title}` | Useful for a "waiting for user" state. |

Batching text deltas every 250 ms (`agent.ts`) worked. Strip `partial` and `message` before forwarding.

## Q5 Ctrl+L

**Answer: `pi.registerShortcut("ctrl+l", …)` can NOT override `app.model.select` while that action is bound to Ctrl+L.** Verified in the TUI:

- `core/extensions/runner.js` holds `RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS`, which includes `app.model.select`, `app.interrupt`, `app.clear`, `app.exit`, `app.suspend`, `app.thinking.cycle`, `app.model.cycleForward/Backward`, `app.tools.expand`, `app.thinking.toggle`, `app.editor.external`, `app.message.copy`, `app.message.followUp`, `tui.input.submit`, `tui.select.confirm/cancel`, `tui.input.copy` and `tui.editor.deleteToLineEnd`. The check uses the **effective** keybindings: `getShortcuts(this.keybindings.getEffectiveConfig())`.
- Result with default keybindings: the startup screen shows `[Extension issues] … Extension shortcut 'ctrl+l' from …agent.ts conflicts with built-in shortcut. Skipping.` Pressing Ctrl+L opened the **model selector**, and the extension handler did not fire.
- With `<agent-dir>/keybindings.json` = `{ "app.model.select": "ctrl+alt+l" }`, pressing Ctrl+L **fired the extension handler** and opened the overlay. A non-blocking warning remains: `Extension shortcut conflict: 'ctrl+l' is built-in shortcut for app.tree.filter.labeledOnly and …agent.ts. Using …agent.ts.` (`app.tree.filter.labeledOnly` defaults to Ctrl+L inside the `/tree` view). That binding is not reserved, so the extension wins in the editor. The `/tree` selector handles its own keys while it has focus, so its Ctrl+L filter still works there.
- To silence that warning as well, the documented remap is:
  ```json
  { "app.model.select": "ctrl+alt+l", "app.tree.filter.labeledOnly": "ctrl+alt+l" }
  ```
  `ctrl+alt+l` in two different contexts (editor and tree view) does not conflict, because the tree binding is only active inside `/tree`. Choose another key if you prefer.
- Dispatch detail: extension shortcuts are checked **first** in `CustomEditor.handleInput`, so they work only while the main editor has focus. They do not fire inside overlays or selectors; the overlay must handle its own close key.

**Plan impact (decision 4):** "pi-dogs takes over Ctrl+L" requires the `keybindings.json` remap. pi-dogs cannot do it on its own at runtime, and it must not write into the user's `~/.pi/agent` without consent. Options:
- (a) A `/agents setup-keys` command or install step that merges the two entries into `<agent-dir>/keybindings.json` with the user's consent and then asks for `/reload`.
- (b) At `session_start`, detect whether Ctrl+L is still bound to `app.model.select` and in that case register a fallback such as `ctrl+alt+l` or `alt+l` for the overlay and show a one-time hint.

`/agents` always works. Keep the shortcut configurable (`overlayShortcut`).

## Q6 UI: dock widget and mirror overlay

### `ctx.ui.setWidget(key, lines | factory, {placement?: "aboveEditor" | "belowEditor"})`

- A string array is limited to **10 lines** (`MAX_WIDGET_LINES`, the rest shows "... (widget truncated)"). Use the component factory `(tui, theme) => Component & {dispose?}` for more lines or for self-updating content. With a factory, update internal state and call `tui.requestRender()` instead of calling `setWidget` again.
- Updating 4 lines at **4 Hz for 4+ minutes** worked without visible problems. The `PI_TUI_WRITE_LOG` capture shows differential rendering: each tick rewrites only the changed widget lines (about 0.5 KB, plus about 0.4 KB for the spinner), each wrapped in synchronized output (`CSI ?2026h … ?2026l`). There were **no full clears**. The expected flicker is therefore nil in WT. The cost is small (about 4 KB/s of terminal output including the spinner).
- Caveat: calling `setWidget(key, array)` rebuilds the component each time. For the real dock, use a factory component that owns its state and render cache.

### `ctx.ui.custom<T>(factory, {overlay:true, overlayOptions?, onHandle?}): Promise<T>`

- `factory(tui, theme, keybindings, done) => Component`. `overlayOptions`: `width` (cols or `"70%"`), `minWidth`, `maxHeight`, `anchor` (default center), `offsetX/Y`, `row/col`, `margin`, `visible(w,h)` and `nonCapturing`. `onHandle(h)` gives an `OverlayHandle`: `setHidden(bool)`, `isHidden()`, `focus()`, `unfocus({target?})`, `isFocused()` and `getBounds()`. Close it by calling `done(result)`, never `handle.hide()`.
- **pi-tui has `Input` (single line) and `Editor` (multi-line)** for reuse. Import them with `import { Input, matchesKey, truncateToWidth } from "@earendil-works/pi-tui"`; the virtual module is provided to extensions, as is `@mariozechner/pi-tui`. `Input`: `new Input({prompt?, placeholder?})`, `.onSubmit = (v) => …`, `.onEscape`, `getValue/setValue`, `handleInput(data)`, `render(width)` and the `focused` flag. Propagate the container's `focused` to the Input so the cursor and IME land in the right place. Other useful components: `ScrollView`, `Markdown`, `Box`, `SelectList`.
- Verified: the overlay opened and live-updated from pipe `mirror` messages (8 updates at 4 Hz). Typed keys went to the Input, and Enter produced `overlay_submit{text:"overlay text"}`. The keys were **not** seen as a prompt (no `input` event). Esc closed it (`done`).
- For the real hub the overlay runs in the **main** Pi. Typing into the steer Input there never touches the child's `input` event, so there is no false takeover.

## Q7 Clean shutdown

- **`ctx.shutdown(): void`** is available in every context and performs an orderly quit: TUI stop, then `session_shutdown{reason:"quit"}`, then exit 0. In the interactive TUI it is **deferred while the agent is busy**: `shutdownRequested = true`, and it runs on `agent_settled` (`interactive-mode.js`, `checkShutdownRequested`). Shortcut contexts only set the flag.
  - Verified: a `shutdown` sent over the pipe while idle made the child exit within about 80 ms (`bye{reason:"quit"}`, exit code 0, WT tab closed).
  - Verified: the `subagent_done({summary})` tool calls `ctx.shutdown()` mid-turn. The tool result also returns `terminate: true`, so no follow-up LLM call is made. The process exits right after `agent_settled`, and the seeded run exited on its own.
  - **Race found:** in the first run the model called `subagent_done` spontaneously. The driver reacted to `status:idle` and sent a new `task` immediately. That prompt started, and the pending shutdown then killed the session mid-run. **Rule:** after `done`, the hub must not send more work. The agent should mark itself "closing" and reject or ignore further `task`/`steer` messages.
- **Windows Terminal and the exit code:** the default `closeOnExit` ("graceful") keeps the tab open with "[process exited with code N]" when N ≠ 0. After a forced kill the tab stayed open. `launch-child.mjs` therefore **always exits 0** and records the real code and signal in `exit.json`. With that, every run closed its tab, and the named window disappeared with its last tab.
- **Process tree in a WT tab:** `WindowsTerminal.exe → node launcher.mjs → cmd.exe (pi.cmd shim) → node …/pi cli.js`. The main Pi is **not** an ancestor, so killing children when the main Pi exits must be explicit:
  1. In `session_shutdown` (only for `reason:"quit"`): send `shutdown` to every agent over the pipe and await `bye` with a short timeout. The handler is awaited.
  2. Fallback: `taskkill /PID <pi pid from hello> /T /F`. Kill the **pi** process, not the launcher, so the launcher still writes `exit.json` and exits 0, which closes the tab. `process.kill(pid, "SIGTERM")` on Windows is TerminateProcess: no `session_shutdown`, and the session file may lose its last entry.
  3. The main Pi does not register a SIGINT or SIGBREAK handler on win32 (only SIGTERM, which cannot be delivered gracefully on Windows). A hard close of the main window therefore skips `session_shutdown`. The agents must treat a **pipe close without `shutdown`** as "hub gone". The plan's timeout rule covers this: the agent should quit, or stay open for manual use (configurable).

## Q8 Session seeding

The reference (`hazat-subagents/pi-extension/subagents/session.ts`, `seedSubagentSessionFile`) writes only the header line `{"type":"session","version":3,id,timestamp,cwd,parentSession}`. In "fork" mode it also copies the parent's entries up to the last user message. The task then goes in as the first prompt.

Minimal approach for pi-dogs, verified with 0.87.1: a header plus **one `custom_message` entry** that carries the caller-written context summary. Start with `pi --session <file>`.

```ts
const header = { type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd, parentSession: parentFile /* optional */ };
const ctxEntry = { type: "custom_message", id: randomBytes(4).toString("hex"), parentId: null,
  timestamp: new Date().toISOString(), customType: "pi-dogs-context", display: true,
  content: `Context from the main agent:\n${context}` };
writeFileSync(file, [header, ctxEntry].map((e) => JSON.stringify(e)).join("\n") + "\n");
// launcher: pi --session <file> -e agent.ts --pi-dogs-launch=<launch.json> ...
```

- Result: the TUI showed the `[pi-dogs-context]` message. After `sendUserMessage("What is the secret codename in the context above? …")` the model answered `subagent_done{summary:"BLUE-HERON-7"}`, so the custom message is part of the LLM context. Pi appended its own entries to the same file (`thinking_level_change`, then the system message, user, assistant and toolResult), which confirms that the hand-written file loads as a valid v3 session.
- `custom_message` is better than a fake `user` message: it is clearly marked as injected, and it does **not** trigger the `input` event, so there is no takeover false positive. `display:false` hides it in the TUI but keeps it in context.
- The file can live anywhere. To make `/resume` in the project find it, put it in `~/.pi/agent/sessions/--<cwd-encoded>--/<timestamp>_<uuid>.jsonl`. Alternatively, pass `--session-dir`, or use `--session-id <id>` with a known id.
- `fork: true` (full context): copy the parent's entries as the reference does. Exclude the parent's header, keep the tree ids and parentIds unchanged, and cut before the last user message.

---

## Plan changes / decisions required

1. **Ctrl+L needs a keybindings remap** (Q5). pi-dogs cannot override `app.model.select` at runtime (hard-coded reserved list). Ship an opt-in setup step that writes `<agent-dir>/keybindings.json`, and a fallback shortcut when Ctrl+L is still taken.
2. **Stable pipe name across `/reload`, `/new` and `/resume`** (Q1). `session_shutdown` and `session_start` also fire for these, with a fresh runtime. Use `pi-dogs-<pid>` or a persisted hubId, reconnect logic in the agent, and kill children only on `reason:"quit"`.
3. **Launcher must exit 0** (the real code goes in `exit.json`), or WT keeps dead tabs or windows open (Q7).
4. **Kill children by the pi PID from `hello`**, not via the process tree of the main Pi (they are not descendants), and prefer the graceful pipe `shutdown` (Q7).
5. **Never pass the task as a CLI argument** (it would show up as `source:"interactive"`). Send it with `sendUserMessage` (Q3). When busy, always pass `deliverAs`, or the message is silently lost (Q2).
6. **After `done` the agent is "closing"**. The hub must not queue new work, because a pending `ctx.shutdown()` fires at the next `agent_settled` (Q7).
7. Layout approach B (one WT window per agent) fits: every child ran in its own named window (`wt -w <name> new-tab …`), and `ctx.ui.setTitle()` is available. One observation: a WT window list later showed the title `π - pi-api` (Pi's own title) instead of the title the extension set in `session_start`. This was not investigated further. Plan for re-applying the title after startup.
