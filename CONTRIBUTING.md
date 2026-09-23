# Contributing to pi-dogs

Thanks for your interest! The project is pre-alpha, so expect things to move.

## Setup

- Node.js 24 or newer. Source files are TypeScript and run directly through
  Node's type stripping; there is no build step.
- `npm install` installs the development tools and the one runtime
  dependency, [koffi](https://koffi.dev) (FFI for the Win32 calls of the
  Windows Terminal backend: window discovery, tiling, focus). Please do not
  add further runtime dependencies without discussing it first. The pi
  packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`,
  `typebox`) are provided by pi at runtime; `npm run typecheck` links them
  from the global pi installation.

## Before opening a pull request

```sh
npm run typecheck
npm test
```

- Write code, comments and docs in English.
- Keep changes focused; one topic per pull request.
- Add or update unit tests (`test/unit/`) for any logic change.
- Use only erasable TypeScript syntax (no `enum`, no `namespace`, no parameter
  properties), because Node strips types instead of compiling them.
- Add a line under "Unreleased" in `CHANGELOG.md` for user-visible changes.

## Reporting bugs

Please include your Windows version, Windows Terminal version, pi version,
display resolution and scaling, and steps to reproduce.
