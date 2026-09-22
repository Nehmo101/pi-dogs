// Drives hub.ts non-interactively: runs the main Pi in RPC mode (so we can watch its events on stdout),
// connects to the hub's named pipe like a sub agent would, and delivers "results" while the main agent
// is idle and while it is busy. Usage: node hub-driver.mjs
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, appendFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const logs = join(here, "logs");
const out = join(logs, "hub-driver.log");
rmSync(join(logs, "hub-pipe.txt"), { force: true });
rmSync(out, { force: true });
rmSync(join(logs, "hub.log"), { force: true });
const log = (...a) => { const s = `${new Date().toISOString()} ${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}`; console.log(s); appendFileSync(out, s + "\n"); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const env = { ...process.env, PI_CODING_AGENT_DIR: join(here, "agentdir"), PI_OFFLINE: "1" };
const pi = spawn("pi", ["--mode", "rpc", "--no-session", "--model", "ollama/qwen3.5:4b", "-e", join(here, "hub.ts")], { cwd: here, env, shell: true });
let buf = "";
const waiters = [];
pi.stdout.setEncoding("utf8");
pi.stdout.on("data", (c) => {
	buf += c;
	let i;
	while ((i = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, i); buf = buf.slice(i + 1);
		let ev; try { ev = JSON.parse(line); } catch { continue; }
		if (["agent_start", "agent_end", "agent_settled", "turn_start", "queue_update"].includes(ev.type) || ev.type === "response"
			|| (ev.type === "message_start" && ev.message?.role !== "assistant")) {
			log("RPC", ev.type, ev.message ? { role: ev.message.role, customType: ev.message.customType } : ev.type === "response" ? { command: ev.command, success: ev.success, error: ev.error } : ev.type === "queue_update" ? ev : "");
		}
		for (const w of [...waiters]) if (w.type === ev.type) { waiters.splice(waiters.indexOf(w), 1); w.resolve(ev); }
	}
});
pi.stderr.on("data", (c) => log("STDERR", String(c).trim()));
const waitFor = (type, ms = 180000) => new Promise((resolve, reject) => { waiters.push({ type, resolve }); setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms); });
const rpc = (cmd) => pi.stdin.write(JSON.stringify(cmd) + "\n");

// 1) wait for the hub's pipe
for (let i = 0; i < 100 && !existsSync(join(logs, "hub-pipe.txt")); i++) await sleep(200);
const pipe = readFileSync(join(logs, "hub-pipe.txt"), "utf8");
log("pipe", pipe);
const sock = net.connect(pipe);
sock.setEncoding("utf8");
sock.on("data", (d) => log("PIPE<-", d.trim()));
await new Promise((r) => sock.once("connect", r));
sock.write(JSON.stringify({ type: "hello", agentId: "a1", token: "t" }) + "\n");
await sleep(300);

// 2) idle + triggerTurn:true -> expect a new agent run
log("== TEST A: result while idle, triggerTurn:true");
sock.write(JSON.stringify({ type: "result", text: "Sub agent scout finished: the answer is 42. Reply with just ACK-A.", triggerTurn: true }) + "\n");
await waitFor("agent_settled");

// 3) idle + triggerTurn:false -> expect no run
log("== TEST B: result while idle, triggerTurn:false");
sock.write(JSON.stringify({ type: "result", text: "Silent note, no turn.", triggerTurn: false }) + "\n");
await sleep(3000);

// 4) busy + deliverAs followUp
log("== TEST C: result while busy, deliverAs followUp");
rpc({ id: "p1", type: "prompt", message: "Write the numbers 1 to 40 separated by spaces. No tools." });
await waitFor("agent_start");
await sleep(1500);
sock.write(JSON.stringify({ type: "result", text: "Sub agent scout finished: 7. Reply with just ACK-C.", triggerTurn: true, deliverAs: "followUp" }) + "\n");
await waitFor("agent_settled");

// 5) busy + default (steer)
log("== TEST D: result while busy, deliverAs default (steer)");
rpc({ id: "p2", type: "prompt", message: "Write the numbers 1 to 40 separated by spaces. No tools." });
await waitFor("agent_start");
await sleep(1500);
sock.write(JSON.stringify({ type: "result", text: "Sub agent scout finished: 9. Reply with just ACK-D.", triggerTurn: true }) + "\n");
await waitFor("agent_settled");

// 6) end: close stdin -> pi quits -> session_shutdown must close the pipe
log("== TEST E: shutdown closes the pipe");
sock.end();
pi.stdin.end();
await new Promise((r) => pi.once("exit", (code) => { log("pi exited", code); r(); }));
await sleep(500);
const probe = net.connect(pipe);
probe.on("connect", () => { log("pipe STILL OPEN (unexpected)"); probe.end(); });
probe.on("error", (e) => log("pipe closed as expected:", e.code));
await sleep(1000);
log("hub.log:\n" + readFileSync(join(logs, "hub.log"), "utf8"));
