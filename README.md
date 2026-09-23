# pi-dogs

Interactive subagents for [pi](https://pi.dev) on native Windows.

The main pi agent starts **dogs**: sub agents that are complete, interactive
pi sessions, each in its own Windows Terminal window, tiled next to the main
window. The main agent keeps working while they run, can steer them, and
receives their results automatically. You can watch every dog live from the
main pi, minimize its window, or click into it and take over by hand. Hub and
dogs talk over a named pipe; no WSL, tmux or cmux required.

> **Status: alpha.** The core works end to end (tested with pi 0.87.1,
> Windows 11, Windows Terminal 1.24 and local models). Expect rough edges.

## Requirements

- Windows 10/11 with [Windows Terminal](https://aka.ms/terminal) (`wt.exe` on
  `PATH`), and pi started **inside** Windows Terminal
- Node.js 24 or newer
- pi 0.87 or newer (`npm install -g @earendil-works/pi-coding-agent`)

## Install

```sh
pi install C:\path\to\pi-dogs            # local checkout
pi install git:github.com/<owner>/pi-dogs # or from git
```

Then start `pi` in a Windows Terminal tab. pi loads only the hub extension;
the agent extension is passed to each dog automatically.

## Quick start

Ask the main agent in plain language:

> Start two subagents: one finds all callers of `createSurface`, the other
> reviews `src/hub/registry.ts`. Use ollama/qwen3.5:4b for both.

Each dog gets its own window and a funny name ("Sir Wuffelot", "Bello
Baggins", …). The dock above the editor shows them; press **Alt+M** for the
live mirror view. When a dog is done, its result arrives in the main
conversation and its window closes.

Start a dog yourself with `/dogs new <task>`.

## Tools for the main agent

| Tool | Parameters | What it does |
|---|---|---|
| `subagent` | `task`, `context` (required, written by the caller), `name?`, `model?`, `role?`, `tools?`, `cwd?`, `mode?` (`autonomous` \| `interactive`), `fork?` | Starts a dog and returns at once. The result arrives later as a message with name, model, usage/cost and the session file. The tool description lists the models that are usable right now. |
| `subagent_steer` | `name`, `message`, `mode?` (`steer` \| `followUp`) | Sends a message to a running dog. |
| `subagent_list` | – | State, model, run time and usage of all dogs. |
| `subagent_kill` | `name` | Stops a dog; its session file is kept. |
| `subagent_config` | `defaultModel?`, `roles?` | Sets the default model and role models for new dogs in this session ("use qwen for research, sonnet for reviews"). |

Inside a dog, the model finishes with `subagent_done({ summary })`. An
autonomous dog that simply stops also reports its last answer.

Model choice for a new dog: `model` → `role` → session default
(`subagent_config`, `/dogs model`) → `models.default` in `pi-dogs.json` → the
main agent's model. Patterns work like pi's `--model`: `provider/id`, a bare
id, a glob such as `*sonnet*`, optionally with `:<thinking>` (for example
`*sonnet*:high`). Unknown models are rejected before a window opens, with
suggestions.

## Commands

| Command | Effect |
|---|---|
| `/dogs` | List dogs |
| `/dogs mirror [name]` | Open the live mirror view (same as the shortcut) |
| `/dogs show <name>` | Bring a dog's window back and focus it |
| `/dogs min <name>` | Minimize a dog's window (it keeps running) |
| `/dogs steer <name> <text>` | Send a message to a dog |
| `/dogs kill <name>` | Stop a dog |
| `/dogs model [pattern\|reset]` | Show or set the default model for new dogs (this pi session) |
| `/dogs new [--model m] [--interactive] [--name n] <task>` | Start a dog yourself |
| `/dogs setup-keys` | Free Ctrl+L for the mirror view (see below) |
| `/done [summary]` | *In a dog's window:* hand the dog back to the main agent |

## Mirror view and shortcuts

The mirror view shows a dog's output, tool calls and state live, inside the
main pi:

- **Enter** – type a steering message (Enter sends, Esc goes back)
- **Tab / Shift+Tab** – next / previous dog
- **R** restore window · **M** minimize · **K K** kill · **↑↓ PgUp PgDn** scroll · **Esc** close

**Alt+M** always opens it. **Ctrl+L** is the intended shortcut, but pi
reserves Ctrl+L for its model selector and extensions cannot take it over.
Run `/dogs setup-keys` once: after asking for confirmation it merges

```json
{ "app.model.select": "ctrl+alt+l", "app.tree.filter.labeledOnly": "ctrl+alt+l" }
```

into `~/.pi/agent/keybindings.json` (all other entries are kept; actions you
already moved are left alone). After `/reload`, Ctrl+L opens the mirror view
and the model selector is on Ctrl+Alt+L (or `/model`).

## Taking over a dog

Click into a dog's window and type. The dog is then marked "by hand" (✋),
the main agent is told not to wait for it, and it no longer finishes on its
own. Type `/done [summary]` in the dog when you are finished; the result goes
to the main agent.

## Configuration

Optional file `~/.pi/agent/pi-dogs.json` (or `$PI_CODING_AGENT_DIR/pi-dogs.json`).
All settings and defaults live in [`src/hub/config.ts`](src/hub/config.ts);
invalid values are reported and replaced by the default.

```json
{
  "models": {
    "default": "ollama/qwen3.5:4b",
    "roles": { "scout": "ollama/qwen3.5:4b", "review": "*sonnet*" }
  },
  "maxAgents": 4
}
```

| Setting | Default | Meaning |
|---|---|---|
| `models.default` | – (main agent's model) | Default model for new dogs |
| `models.roles` | `{}` | Model per `role` |
| `maxAgents` | `6` | Maximum number of unfinished dogs |
| `closeOnDone` | `true` | Close a dog's window after it reported its result |
| `killChildrenOnExit` | `true` | Stop dogs when the main pi quits (otherwise they stay open) |
| `defaultMode` | `"autonomous"` | Mode when the caller does not pass one |
| `dogNames`, `dogNamesMode` | `[]`, `"append"` | Extra names, or `"replace"` the built-in list |
| `overlayShortcut` | `"ctrl+l"` | Mirror shortcut (used only once pi no longer reserves it) |
| `fallbackShortcut` | `"alt+m"` | Always-available mirror shortcut (`""` disables it) |
| `eventDetail` | `"full"` | `"minimal"` stops forwarding streamed text |
| `helloTimeoutMs` | `30000` | A dog that has not connected by then is marked failed |
| `hubGoneGraceMs` | `30000` | How long a dog waits for a vanished main pi before quitting |
| `quitGraceMs` | `400` | On quit: wait for dogs before killing them |
| `killGraceMs` | `3000` | `subagent_kill`: wait for a graceful exit before killing |
| `mirrorLines` | `400` | Lines kept per dog for the mirror view |
| `layout` | `{}` | Window layout preferences, see [docs/window-backend.md](docs/window-backend.md) |

A task or steer message may be up to 512 KiB; put larger material into a
file and name it. A dog started in the main pi's folder gets the main pi's
project-trust decision; in another folder it gets the decision you stored
for that folder, or runs without project-local resources (`--no-approve`),
so it never waits at pi's trust prompt.

## Troubleshooting

- **"pi is not running inside Windows Terminal"** – start pi from a Windows
  Terminal tab (the backend needs `WT_SESSION` and `wt.exe`).
- **A dog window stays open with an error** – the dog did not connect within
  `helloTimeoutMs`; the window is kept for diagnosis. The main agent gets a
  "failed" message with the reason.
- **Ctrl+L opens the model selector** – run `/dogs setup-keys`, then
  `/reload`. Until then use Alt+M or `/dogs mirror`.
- **Debug log** – set `PI_DOGS_DEBUG=1` before starting pi to log the hub's
  lifecycle and the window backend to `%TEMP%\pi-dogs\debug.log`
  (or `PI_DOGS_DEBUG=<file>`).
- **Resuming a dog** – every result names the dog's session file; continue
  it with `pi --session <file>`.

## Documentation

- [Architecture](docs/architecture.md)
- [Protocol v1 (normative)](docs/protocol.md)
- [Window backend](docs/window-backend.md)
- [Plan (German)](docs/PLAN.md) and the [Phase 0 spikes](docs/spike/)

## Development

Requires Node.js 24 or newer (TypeScript runs natively via type stripping;
there is no build step).

```sh
npm install
npm run typecheck   # links the globally installed pi for its types, then runs tsc
npm test            # unit + integration tests (real named pipes, no pi needed)
npm run test:e2e    # real pi + real dogs in Windows Terminal + a local model
```

`npm run typecheck` runs `scripts/link-pi.mjs` first: instead of installing
the large pi package as a dev dependency, it links the global pi
installation (and its `pi-tui` and `typebox`) into `node_modules`. Set
`PI_DOGS_PI_DIR` to use another pi package directory.

The end-to-end test uses a temporary agent directory with a copy of your
`models.json`; it never touches your settings. Choose the model with
`PI_DOGS_E2E_MODEL` (default `ollama/qwen3.5:4b`) and the backend with
`PI_DOGS_E2E_BACKEND=console` if Windows Terminal is not available.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). pi-dogs is inspired by
[pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents)
by HazAT (MIT); see [NOTICE](NOTICE).
