// `npm run test:wt`: Windows Terminal integration test (not part of `npm test`).
//
// Opens a dedicated Windows Terminal window that plays the main pi window and
// runs host.ts inside it (so your own terminal window is never re-tiled),
// waits for the result and prints it. Needs Windows, Windows Terminal and an
// interactive desktop. Screenshots go to docs/screens/.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { findWtExe } from "../../../src/backend/windows-terminal/launch.ts";

if (process.platform !== "win32") {
  console.log("test:wt skipped: Windows only");
  process.exit(0);
}
const wt = findWtExe();
if (!wt) {
  console.error("test:wt: wt.exe not found");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const result = join(tmpdir(), `pi-dogs-wt-test-${process.pid}.json`);
rmSync(result, { force: true });
const argv = [
  "-w", `pi-dogs-wt-test-${process.pid}`,
  "--pos", "120,120", "--size", "140,40",
  "new-tab", "--title", "pi-dogs wt test (main)", "--suppressApplicationTitle", "--tabColor", "#444444",
  "--", process.execPath, join(here, "host.ts"), result,
];
spawn(wt, argv, { stdio: "ignore" });
console.log("test:wt: running in a new Windows Terminal window ...");

const deadline = Date.now() + 180_000;
while (!existsSync(result) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
if (!existsSync(result)) {
  console.error("test:wt: no result after 180 s");
  process.exit(1);
}
await new Promise((r) => setTimeout(r, 100));
const { ok, failures, timings, log } = JSON.parse(readFileSync(result, "utf8")) as {
  ok: boolean;
  failures: string[];
  timings: Record<string, unknown>;
  log: string[];
};
rmSync(result, { force: true });
console.log(log.join("\n"));
console.log("\ntimings:", JSON.stringify(timings, null, 2));
console.log(ok ? "\ntest:wt PASSED" : `\ntest:wt FAILED:\n  ${failures.join("\n  ")}`);
process.exit(ok ? 0 : 1);
