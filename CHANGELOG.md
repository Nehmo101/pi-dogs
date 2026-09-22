# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

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
