#!/usr/bin/env node
// pi-dogs launcher: runs inside a dog's terminal window.
//
//   node launcher.mjs <launch.json>
//
// Starts pi with inherited stdio (so the dog gets the real interactive TUI),
// waits for it to end, records the outcome in the exit file named by the
// launch file, and ALWAYS exits with code 0. A non-zero exit would make
// Windows Terminal keep a dead window open ("[process exited with code N]");
// the real exit code lives in the exit file (docs/protocol.md).
//
// The launch file is only read here. The agent extension inside pi deletes it
// after reading, because it contains the dog's secrets (pipe token, hub secret).
//
// Plain JavaScript on purpose: Node does not strip types for files under
// node_modules, and this script must work wherever the package is installed.
// The exit-file format mirrors ExitFile in src/protocol/launch.ts.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PI_PACKAGE = ["@earendil-works", "pi-coding-agent"];

function writeExit(exitFile, data) {
  try {
    writeFileSync(exitFile, JSON.stringify({ ...data, endedAt: new Date().toISOString() }) + "\n", "utf8");
  } catch (err) {
    console.error(`pi-dogs launcher: could not write ${exitFile}: ${err.message}`);
  }
}

/**
 * Resolve a bare "pi" command to `node <cli.js>` on Windows, where `pi` is an
 * npm .cmd shim that would otherwise need a shell (and cmd.exe quoting). Any
 * other command is returned unchanged.
 */
export function resolvePiCommand(command, args, env = process.env) {
  if (command !== "pi" || process.platform !== "win32") return { command, args };
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!dir || !existsSync(join(dir, "pi.cmd"))) continue;
    const pkgDir = join(dir, "node_modules", ...PI_PACKAGE);
    try {
      const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
      const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
      if (bin) return { command: process.execPath, args: [join(pkgDir, bin), ...args] };
    } catch {
      // Not an npm shim we understand; fall through to the shell below.
    }
    return { command: join(dir, "pi.cmd"), args, shell: true };
  }
  return { command, args, shell: true };
}

function quoteForCmd(arg) {
  return /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

function main() {
  const launchPath = process.argv[2];
  if (!launchPath) {
    console.error("usage: node launcher.mjs <launch.json>");
    return;
  }
  let launch;
  try {
    launch = JSON.parse(readFileSync(launchPath, "utf8").replace(/^\uFEFF/, ""));
  } catch (err) {
    console.error(`pi-dogs launcher: cannot read ${launchPath}: ${err.message}`);
    // Without the launch file we do not know where the exit file goes; the
    // hub notices the missing hello and reports a startup timeout.
    return;
  }

  const exitFile = launch.exitFile ?? join(dirname(launchPath), "exit.json");
  const env = { ...process.env, ...launch.env };
  const resolved = resolvePiCommand(launch.pi.command, launch.pi.args, env);
  const options = { cwd: launch.cwd, env, stdio: "inherit", windowsHide: false };

  let child;
  try {
    child = resolved.shell
      ? spawn([resolved.command, ...resolved.args].map(quoteForCmd).join(" "), { ...options, shell: true })
      : spawn(resolved.command, resolved.args, options);
  } catch (err) {
    writeExit(exitFile, { code: null, signal: null, error: err.message });
    return;
  }

  // Keystrokes such as Ctrl+C belong to pi; the launcher must outlive it.
  for (const signal of ["SIGINT", "SIGBREAK", "SIGTERM", "SIGHUP"]) {
    try {
      process.on(signal, () => {});
    } catch {
      // Signal not supported on this platform.
    }
  }

  child.on("error", (err) => {
    writeExit(exitFile, { code: null, signal: null, error: err.message });
    process.exit(0);
  });
  child.on("exit", (code, signal) => {
    writeExit(exitFile, { code, signal });
    process.exit(0);
  });
}

// Compare real paths: the package may be reached through a junction, symlink
// or subst drive, and then argv[1] and import.meta.url name different paths.
function canonical(path) {
  let real;
  try {
    real = realpathSync.native(path);
  } catch {
    real = resolve(path);
  }
  return process.platform === "win32" ? real.toLowerCase() : real;
}

const isMain = process.argv[1] !== undefined && canonical(process.argv[1]) === canonical(fileURLToPath(import.meta.url));
if (isMain) main();
