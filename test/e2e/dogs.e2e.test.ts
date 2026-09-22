/**
 * End-to-end: a real main pi (RPC mode) with the hub extension starts two
 * real dogs (interactive pi in their own windows, local model), receives
 * both results, and stops everything on quit.
 *
 *   npm run test:e2e
 *
 * Environment:
 *   PI_DOGS_E2E_MODEL     model for main pi and dogs (default ollama/qwen3.5:4b)
 *   PI_DOGS_E2E_BACKEND   "wt" (default, needs Windows Terminal) or "console"
 *   PI_DOGS_E2E_TIMEOUT   per-dog timeout in ms (default 240000; local models can be slow)
 *
 * The test uses a temporary agent dir with a copy of ~/.pi/agent/models.json
 * only, so the user's settings, sessions and keybindings are never touched.
 */
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { runRootForPid } from "../../src/protocol/launch.ts";
import { REPO, RpcPi, type RpcEvent } from "./rpc-pi.ts";

const MODEL = process.env.PI_DOGS_E2E_MODEL ?? "ollama/qwen3.5:4b";
const BACKEND = process.env.PI_DOGS_E2E_BACKEND ?? "wt";
const TIMEOUT = Number(process.env.PI_DOGS_E2E_TIMEOUT ?? 240_000);

const isResult = (e: RpcEvent) =>
  e.type === "message_end" && (e.message as { role?: string; customType?: string } | undefined)?.customType === "pi-dogs-result";
const contentOf = (e: RpcEvent) => String((e.message as { content?: unknown }).content ?? "");

describe("pi-dogs end to end", { timeout: TIMEOUT * 3 + 60_000 }, () => {
  let dir: string;
  let pi: RpcPi;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-dogs-e2e-"));
    const agentDir = join(dir, "agent");
    const workDir = join(dir, "work");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    const models = join(homedir(), ".pi", "agent", "models.json");
    if (existsSync(models)) copyFileSync(models, join(agentDir, "models.json"));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ quietStartup: true }));
    writeFileSync(join(agentDir, "pi-dogs.json"), JSON.stringify({ models: { default: MODEL }, helloTimeoutMs: 60_000 }));

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_DOGS_DEBUG: process.env.PI_DOGS_DEBUG ?? join(dir, "debug.log"),
    };
    delete env.PI_DOGS_AGENT_ID;
    if (BACKEND === "console") env.PI_DOGS_BACKEND_MODULE = join(REPO, "test", "e2e", "console-backend.ts");
    pi = new RpcPi(["--no-session", "--model", MODEL, "--thinking", "off", "-e", join(REPO, "src", "hub", "index.ts")], { cwd: workDir, env });
  });

  after(async () => {
    await pi?.quit();
    if (process.env.PI_DOGS_E2E_KEEP) console.log(`kept ${dir}`);
    else rmSync(dir, { recursive: true, force: true });
  });

  it("starts two dogs and receives both results", async (t) => {
    const state = await pi.command({ type: "get_state" }, 60_000);
    assert.equal(state.success, true, JSON.stringify(state));

    const tasks = [
      ["Scout", "WOOF-ONE"],
      ["Fetch", "WOOF-TWO"],
    ] as const;
    for (const [name, word] of tasks) {
      const task = `Reply with exactly the word ${word} and nothing else. Do not use any tools except subagent_done; then call subagent_done with summary ${word}.`;
      const response = await pi.command({ type: "prompt", message: `/dogs new --name ${name} ${task}` });
      assert.equal(response.success, true, JSON.stringify(response));
    }

    const results: string[] = [];
    for (let i = 0; i < tasks.length; i++) {
      const event = await pi.waitFor((e) => isResult(e) && !results.includes(contentOf(e)), TIMEOUT, `result ${i + 1}`);
      results.push(contentOf(event));
    }
    for (const r of results) t.diagnostic(oneLine(r));
    // The results trigger a turn of the main agent; we do not need its answer.
    await pi.command({ type: "abort" });

    for (const [name, word] of tasks) {
      const text = results.find((r) => r.includes(`"${name}"`));
      assert.ok(text, `result for ${name}: ${results.map(oneLine).join(" || ")}`);
      assert.match(text, /finished/);
      assert.match(text, new RegExp(word), text);
      assert.match(text, /Session file: .+\.jsonl/);
    }
  });

  it("lets the main model start a dog with the subagent tool", async (t) => {
    const before = pi.events.length;
    const prompt =
      'Call the tool "subagent" exactly once with name "Tooly", task "Reply with the word WOOF-TOOL, then call subagent_done with summary WOOF-TOOL", ' +
      'and context "End-to-end test of pi-dogs". Do nothing else and do not wait for the result.';
    await pi.command({ type: "prompt", message: prompt });
    const call = await pi.waitFor(
      (e) => pi.events.indexOf(e) >= before && e.type === "tool_execution_end" && e.toolName === "subagent",
      TIMEOUT,
      "subagent tool call",
    );
    t.diagnostic(`tool result: ${JSON.stringify((call.result as { content?: unknown })?.content ?? call.result).slice(0, 300)}`);
    assert.equal(call.isError, false, JSON.stringify(call.result));
    const result = await pi.waitFor((e) => isResult(e) && contentOf(e).includes('"Tooly"'), TIMEOUT, "Tooly result");
    t.diagnostic(oneLine(contentOf(result)));
    assert.match(contentOf(result), /WOOF-TOOL/);
    await pi.command({ type: "abort" });
  });

  it("steers an interactive dog, and /dogs kill stops it", async (t) => {
    const before = pi.events.length;
    await pi.command({ type: "prompt", message: "/dogs new --interactive --name Steery Answer with the single word READY." });
    // Interactive dogs never finish on their own; wait until it has answered (idle).
    const deadline = Date.now() + TIMEOUT;
    let listing = "";
    while (Date.now() < deadline) {
      await pi.command({ type: "prompt", message: "/dogs list" });
      listing = notifications(pi.events.slice(before)).filter((n) => n.includes("Steery")).at(-1) ?? "";
      if (/Steery · idle/.test(listing)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    t.diagnostic(listing);
    assert.match(listing, /Steery · idle/);

    await pi.command({ type: "prompt", message: "/dogs steer Steery Now answer with the single word AGAIN." });
    assert.ok(notifications(pi.events.slice(before)).some((n) => n === "Sent to Steery."));

    await pi.command({ type: "prompt", message: "/dogs kill Steery" }, 30_000);
    const stopped = await pi.waitFor((e) => isResult(e) && contentOf(e).includes('"Steery"'), 30_000, "stop report");
    t.diagnostic(oneLine(contentOf(stopped)));
    assert.match(contentOf(stopped), /was stopped \(stopped by the user\)/);
  });

  it("quits cleanly and removes its run directory", async () => {
    const mainPid = pi.child.pid!;
    const code = await pi.quit();
    assert.equal(code, 0, pi.stderr.slice(-2000));
    assert.equal(existsSync(runRootForPid(mainPid)), false, "run directory removed on quit");
  });
});

function oneLine(text: string): string {
  return text.split(/\r?\n/).join(" | ");
}

function notifications(events: RpcEvent[]): string[] {
  return events.filter((e) => e.type === "extension_ui_request" && e.method === "notify").map((e) => String(e.message));
}
