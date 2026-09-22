// Minimal stand-in for pi-dogs' launcher.mjs: runs inside the Windows Terminal tab/window.
// Sets the environment explicitly (wt tabs inherit WT's env, not the caller's), starts the
// interactive pi with inherited stdio, and writes <launch>.exit.json when pi ends.
// Usage: node launch-child.mjs <launch.json> <agentDirName> [--session <file>]
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [launchFile, agentDirName = "agentdir", ...extra] = process.argv.slice(2);
const launch = JSON.parse(readFileSync(launchFile, "utf8"));
const exitFile = `${launchFile}.exit.json`;
const env = {
	...process.env,
	PI_CODING_AGENT_DIR: join(here, agentDirName), // isolated agent dir (spike only; real launcher keeps ~/.pi/agent)
	PI_OFFLINE: "1",
	PI_TUI_WRITE_LOG: join(here, "logs", `tui-${launch.agentId}.log`), // raw ANSI stream for inspection
};
const args = ["-e", join(here, "agent.ts"), `--pi-dogs-launch=${launchFile}`, "--model", "ollama/qwen3.5:4b", "--thinking", "off", ...extra];
// On Windows `pi` is a .cmd shim, so it has to go through the shell.
const child = spawn("pi", args.map((a) => (/\s/.test(a) ? `"${a}"` : a)), { stdio: "inherit", env, shell: true, cwd: here });
child.on("exit", (code, signal) => {
	writeFileSync(exitFile, JSON.stringify({ code, signal, at: new Date().toISOString() }));
	// Always exit 0 so Windows Terminal (closeOnExit "graceful") closes the tab/window; the real code is in exit.json.
	process.exit(0);
});
