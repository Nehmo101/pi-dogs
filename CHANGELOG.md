# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Dogs inherit `--bash-guard-disabled` from the main pi, so a session started
  without bash-guard prompts gets prompt-free dogs too.

- Project scaffold (package manifest, CI, license, docs).
- Protocol v1 message types and JSONL framing (`src/protocol/`).
- Pure layout engine `computeLayout` (`src/layout/`).
- Hub extension (`src/hub/`): tools `subagent`, `subagent_steer`,
  `subagent_list`, `subagent_kill` and `subagent_config`; the `/dogs` command
  (`list`, `mirror`, `show`, `min`, `steer`, `kill`, `model`, `new`,
  `setup-keys`); named-pipe server on `\\.\pipe\pi-dogs-<pid>` with token
  auth and keep-alive; registry with the `closing` state; results delivered
  to the main agent with name, model, usage and session file.
- Model selection per call, role, session default, `pi-dogs.json` default or
  the main agent's model, validated before a window opens.
- Random dog names (German and English), unique per session.
- Dock widget above the editor and a live mirror overlay with steering
  (Alt+M; Ctrl+L after `/dogs setup-keys`).
- Agent extension (`src/agent/`): task injection, batched and throttled event
  forwarding, takeover detection, `subagent_done` tool and `/done` command,
  automatic result for autonomous runs, reconnect with backoff and reliable
  `done`.
- Launcher (`src/launcher/launcher.mjs`) that runs pi without the `pi.cmd`
  shim, records the exit in `exit.json` and always exits 0.
- Session seeding with the caller's context, optional fork of the main
  conversation.
- Robustness: crash and closed-window detection, reconnect after `/reload`,
  `/new` and `/resume`, graceful then forced shutdown of dogs on quit.
- `pi-dogs.json` settings with validation, `PI_DOGS_DEBUG` debug log.
- Docs: `docs/architecture.md`, normative `docs/protocol.md`.
- Tests: unit, integration over real named pipes with a fake backend, and an
  end-to-end suite (`npm run test:e2e`) with real pi, Windows Terminal and a
  local model.

### Security

- Dogs authenticate the hub: a per-dog `hubSecret` from the launch file must
  come back in `welcome`; anything a peer sends before that is ignored. The
  pipe name gets a random suffix (`\\.\pipe\pi-dogs-<pid>-<random>`).
- Mirrored text and tool arguments are stripped of terminal control
  characters.

### Fixed

- A malformed message or an error in a pipe handler no longer ends the main
  pi; nested payloads are validated; tasks and steer messages over 512 KiB
  are refused with a clear error, and long summaries are truncated.
- `/reload`, `/new`, `/resume` or `/fork` typed inside a dog no longer ends
  it.
- A result that crosses a kill no longer overrides it (and no longer starts
  a main-agent turn during quit); kill settings and in-flight kills survive
  a `/reload`, and a dog reconnecting during a kill gets `shutdown` again.
- A takeover made while the pipe was down reaches the hub after reconnect.
- Closing a dog window by hand is reported as stopped, not as a crash.
- After a `/reload` only the new hub reports results; window closes during
  the reload are no longer lost.
- A dog in another folder no longer hangs at pi's project-trust prompt; a
  dog whose launch file is missing quits.
- Also: no orphaned `starting` dog when a start fails; finished dogs kept
  open are shut down on quit; `/dogs setup-keys` understands the legacy
  `selectModel` name; `/dogs steer` and `/dogs new` keep the text verbatim;
  PID reuse no longer keeps a lost dog forever; only the 20 most recent
  finished dogs are kept; results of dogs from before `/new` or `/resume`
  no longer trigger a turn; the launcher also starts when reached through a
  junction, symlink or `subst` drive; the user is told when a dog window
  kept the keyboard focus.
