import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  consumeLaunchFile,
  describeExit,
  pipeNameForPid,
  readExitFile,
  runRootForPid,
  validateLaunchFile,
  writeLaunchFile,
  type LaunchFile,
} from "../../src/protocol/launch.ts";

const LAUNCHER = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/launcher/launcher.mjs");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-dogs-launch-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sample = (over: Partial<LaunchFile> = {}): LaunchFile => ({
  v: 1,
  agentId: "rex-0001",
  name: "Rex",
  pipe: pipeNameForPid(123),
  token: "secret",
  cwd: dir,
  exitFile: join(dir, "exit.json"),
  pi: { command: process.execPath, args: ["-e", "process.exit(0)"] },
  env: { PI_DOGS_AGENT_ID: "rex-0001" },
  ...over,
});

describe("launch file", () => {
  it("round-trips and is deleted when consumed", () => {
    const file = join(dir, "launch.json");
    writeLaunchFile(file, sample());
    assert.deepEqual(consumeLaunchFile(file), sample());
    assert.equal(existsSync(file), false);
  });

  it("is deleted even when invalid", () => {
    const file = join(dir, "launch.json");
    writeFileSync(file, JSON.stringify({ v: 1, agentId: "x" }));
    assert.throws(() => consumeLaunchFile(file), /"name"/);
    assert.equal(existsSync(file), false);
  });

  it("validates every field", () => {
    assert.throws(() => validateLaunchFile(null), /JSON object/);
    assert.throws(() => validateLaunchFile({ ...sample(), v: 2 }), /version/);
    assert.throws(() => validateLaunchFile({ ...sample(), token: "" }), /"token"/);
    assert.throws(() => validateLaunchFile({ ...sample(), pi: { command: "pi", args: [1] } }), /"pi"/);
    assert.throws(() => validateLaunchFile({ ...sample(), env: { A: 1 } }), /"env"/);
  });

  it("uses a stable pipe name per main pi process", () => {
    assert.equal(pipeNameForPid(4242, "win32"), "\\\\.\\pipe\\pi-dogs-4242");
    assert.match(pipeNameForPid(4242, "linux"), /pi-dogs-4242\.sock$/);
    assert.equal(runRootForPid(7, "C:\\tmp"), join("C:\\tmp", "pi-dogs", "7"));
  });
});

describe("exit file", () => {
  it("reads codes, signals and startup errors", () => {
    const file = join(dir, "exit.json");
    assert.equal(readExitFile(file), undefined);
    writeFileSync(file, JSON.stringify({ code: 3, signal: null, endedAt: "2026-09-23T00:00:00.000Z" }));
    const exit = readExitFile(file)!;
    assert.deepEqual(exit, { code: 3, signal: null, endedAt: "2026-09-23T00:00:00.000Z" });
    assert.equal(describeExit(exit), "exit code 3");
    assert.equal(describeExit({ code: null, signal: "SIGTERM", endedAt: "" }), "ended by signal SIGTERM");
    assert.equal(describeExit({ code: null, signal: null, endedAt: "", error: "ENOENT" }), "could not start pi: ENOENT");
    writeFileSync(file, "not json");
    assert.equal(readExitFile(file), undefined);
  });
});

describe("launcher.mjs", () => {
  const run = (launch: LaunchFile) => {
    const file = join(dir, "launch.json");
    writeLaunchFile(file, launch);
    const result = spawnSync(process.execPath, [LAUNCHER, file], { encoding: "utf8", timeout: 20_000 });
    return { result, file };
  };

  it("records the real exit code, keeps the launch file, and always exits 0", () => {
    const { result, file } = run(sample({ pi: { command: process.execPath, args: ["-e", "process.exit(3)"] } }));
    assert.equal(result.status, 0, result.stderr);
    const exit = JSON.parse(readFileSync(join(dir, "exit.json"), "utf8"));
    assert.equal(exit.code, 3);
    assert.equal(exit.signal, null);
    assert.ok(Date.parse(exit.endedAt) > 0);
    assert.equal(existsSync(file), true, "only the agent extension deletes the launch file");
  });

  it("passes cwd and env to pi", () => {
    const out = join(dir, "seen.json");
    const script = `require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({ cwd: process.cwd(), id: process.env.PI_DOGS_AGENT_ID }))`;
    const { result } = run(sample({ pi: { command: process.execPath, args: ["-e", script] } }));
    assert.equal(result.status, 0, result.stderr);
    const seen = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(resolve(seen.cwd).toLowerCase(), resolve(dir).toLowerCase());
    assert.equal(seen.id, "rex-0001");
  });

  it("records a start failure and still exits 0", () => {
    const { result } = run(sample({ pi: { command: join(dir, "does-not-exist.exe"), args: [] } }));
    assert.equal(result.status, 0);
    const exit = JSON.parse(readFileSync(join(dir, "exit.json"), "utf8"));
    assert.equal(exit.code, null);
    assert.match(exit.error, /ENOENT/);
  });

  it("exits 0 without a launch file argument", () => {
    const result = spawnSync(process.execPath, [LAUNCHER], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.match(result.stderr, /usage/);
  });

  it("resolves a bare pi command through the npm shim to node + cli.js", async () => {
    const { resolvePiCommand } = (await import(pathToFileURL(LAUNCHER).href)) as {
      resolvePiCommand(command: string, args: string[], env: Record<string, string>): { command: string; args: string[]; shell?: boolean };
    };
    assert.deepEqual(resolvePiCommand(process.execPath, ["a"], {}), { command: process.execPath, args: ["a"] });
    if (process.platform !== "win32") return;
    const bin = join(dir, "bin");
    const pkg = join(bin, "node_modules", "@earendil-works", "pi-coding-agent");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(pkg, "dist"), { recursive: true });
    writeFileSync(join(bin, "pi.cmd"), "@echo off\r\n");
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ bin: { pi: "dist/cli.js" } }));
    const resolved = resolvePiCommand("pi", ["--version"], { PATH: bin });
    assert.equal(resolved.command, process.execPath);
    assert.deepEqual(resolved.args, [join(pkg, "dist/cli.js"), "--version"]);
    assert.equal(resolvePiCommand("pi", [], { PATH: dir }).shell, true, "unknown: fall back to the shell");
  });
});
