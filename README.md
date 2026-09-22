# pi-dogs

Interactive subagents for [pi](https://pi.dev) on native Windows.

The main pi agent starts subagents that each run in their own Windows Terminal
window or pane. The main agent keeps working while they run, can steer them,
and receives their results automatically. You can minimize a subagent (it keeps
running and stays visible as a live view inside the main pi) or click into its
window and take over by hand. Hub and subagents talk over a named pipe; no WSL,
tmux or cmux required.

## Status

**Pre-alpha / in development.** Nothing here is usable yet. The protocol and
the layout engine are being built first; the pi extensions are stubs.

## Documentation

- [Plan (German)](docs/PLAN.md)
- Protocol, architecture and troubleshooting docs will follow in `docs/`.

## Development

Requires Node.js 24 or newer (TypeScript runs natively via type stripping).

```sh
npm install
npm run typecheck
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). See [NOTICE](NOTICE) for credits.
