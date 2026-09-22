// Plays the hub for agent.ts: named-pipe server + launches an interactive child Pi in its OWN
// Windows Terminal window (-w pi-dogs-apispike) and drives it through scripted stages.
// Usage: node child-driver.mjs <scenario> [agentDirName]
//   scenario "inject": idle/busy injection, widget, overlay, keystroke window, shutdown via pipe
//   scenario "seed":   seeded session file + autonomous subagent_done -> self exit
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const logs = join(here, "logs");
const scenario = process.argv[2] ?? "inject";
const agentDirName = process.argv[3] ?? "agentdir";
const agentId = `${scenario}-${randomBytes(2).toString("hex")}`;
const out = join(logs, `driver-${scenario}.log`);
rmSync(out, { force: true });
const log = (...a) => { const s = `${new Date().toISOString()} ${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}`; console.log(s); appendFileSync(out, s + "\n"); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pipe = `\\\\.\\pipe\\pi-dogs-apispike-${randomBytes(4).toString("hex")}`;
const token = randomBytes(8).toString("hex");
let sock;
const waiters = [];
const seen = [];
const server = net.createServer((s) => {
	let buf = "";
	s.setEncoding("utf8");
	s.on("data", (c) => {
		buf += c;
		let i;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i); buf = buf.slice(i + 1);
			const m = JSON.parse(line);
			if (m.type === "hello") {
				if (m.token !== token) { log("bad token"); s.destroy(); return; }
				sock = s; s.write(JSON.stringify({ type: "welcome" }) + "\n");
			}
			if (!(m.type === "event" && m.kind === "text_delta")) log("<-", m);
			else log("<- text_delta", JSON.stringify(m.text).slice(0, 80));
			seen.push(m);
			for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
		}
	});
	s.on("close", () => log("pipe client closed"));
});
await new Promise((r) => server.listen(pipe, r));
const waitFor = (pred, ms = 600000) => new Promise((resolve, reject) => { waiters.push({ pred, resolve }); setTimeout(() => reject(new Error("timeout " + pred)), ms); });
const tx = (m) => { log("->", m); sock.write(JSON.stringify(m) + "\n"); };
const isIdle = (m) => m.type === "status" && m.state === "idle";

const launchFile = join(logs, `launch-${agentId}.json`);
writeFileSync(launchFile, JSON.stringify({ pipe, token, agentId, noDoneTool: scenario !== "seed" }));
const extra = [];
if (scenario === "seed") {
	// Q8: seed a session file whose first entry is a custom_message carrying the caller's context summary.
	const sessionFile = join(logs, `seeded-${agentId}.jsonl`);
	const header = { type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: here };
	const ctxEntry = {
		type: "custom_message", id: randomBytes(4).toString("hex"), parentId: null, timestamp: new Date().toISOString(),
		customType: "pi-dogs-context", display: true,
		content: "Context from the main agent (summary): We are testing pi-dogs. The secret codename for this task is BLUE-HERON-7.",
	};
	writeFileSync(sessionFile, [header, ctxEntry].map((e) => JSON.stringify(e)).join("\n") + "\n");
	extra.push("--session", sessionFile);
	log("seeded", sessionFile);
}
// Own named window only. The launcher runs inside it.
const wtArgs = ["-w", "pi-dogs-apispike", "new-tab", "--title", `pi-dogs-apispike ${agentId}`, "-d", here, "--", "node", join(here, "launch-child.mjs"), launchFile, agentDirName, ...extra];
spawn("wt.exe", wtArgs, { detached: true, stdio: "ignore" }).unref();
log("wt started", wtArgs.join(" "));

const hello = await waitFor((m) => m.type === "hello", 60000);
log("HELLO pid", hello.pid);
writeFileSync(join(logs, `child-${scenario}.pid`), String(hello.pid));
await sleep(1500);

if (scenario === "inject") {
	log("== Q6 widget on (4 Hz)");
	tx({ type: "widget", on: true });
	await sleep(3000);

	log("== Q2a sendUserMessage while idle");
	tx({ type: "task", text: "Reply with just: HELLO-1" });
	await waitFor(isIdle);

	log("== Q2b busy: no deliverAs, then steer, then followUp");
	tx({ type: "task", text: "Write the numbers 1 to 60 separated by spaces. No tools." });
	await waitFor((m) => m.type === "status" && m.state === "running");
	await sleep(1500);
	tx({ type: "state" });
	tx({ type: "steer", text: "(no deliverAs) say NODELIVER" });
	await sleep(300);
	tx({ type: "steer", text: "After that, reply with just: STEER-OK", mode: "steer" });
	tx({ type: "steer", text: "Then reply with just: FOLLOWUP-OK", mode: "followUp" });
	await sleep(300);
	tx({ type: "state" });
	await waitFor(isIdle);

	log("== Q2c sendMessage custom while idle, triggerTurn");
	tx({ type: "custom", text: "Hub note: reply with just CUSTOM-OK", triggerTurn: true });
	await waitFor(isIdle);

	log("== Q6 overlay open with mirror");
	tx({ type: "overlay", open: true });
	for (let i = 0; i < 8; i++) { tx({ type: "mirror", lines: Array.from({ length: i + 1 }, (_, k) => `line ${k} of live output`) }); await sleep(250); }

	// Simulated user typing via console input records (inject-keys.ps1), no focus change.
	const keys = (k, ctrlL = false) => new Promise((r) => {
		const a = ["-NoProfile", "-File", join(here, "inject-keys.ps1"), "-TargetPid", String(hello.pid), "-Keys", k, "-Log", join(logs, "inject.log")];
		if (ctrlL) a.push("-CtrlL");
		spawn("pwsh", a, { stdio: "ignore" }).on("exit", r);
	});
	log("== Q6 typing into the overlay Input");
	await keys("overlay text{ENTER}");
	await waitFor((m) => m.kind === "overlay_submit", 20000).catch(() => log("NO overlay_submit"));
	await keys("{ESC}");
	await waitFor((m) => m.kind === "overlay_closed", 20000).catch(() => log("NO overlay_closed"));

	log("== Q3 user types a prompt while idle (takeover)");
	await keys("hello from the user, reply with just: TYPED-OK{ENTER}");
	await waitFor((m) => m.type === "takeover", 20000).catch(() => log("NO takeover"));
	await waitFor(isIdle);

	log("== Q5 Ctrl+L (expect: model selector, extension handler skipped)");
	await keys("", true);
	await waitFor((m) => m.kind === "ctrl+l", 5000).then(() => log("ctrl+l HANDLER FIRED")).catch(() => log("ctrl+l handler did not fire"));
	await keys("{ESC}");
	await sleep(1000);
	tx({ type: "widget", on: false });

	log("== Q7 shutdown via pipe");
	tx({ type: "shutdown" });
} else if (scenario === "remap") {
	// Q5 with agentdir-remap/keybindings.json moving app.model.select to ctrl+alt+l.
	const a = ["-NoProfile", "-File", join(here, "inject-keys.ps1"), "-TargetPid", String(hello.pid), "-Keys", "", "-CtrlL", "-Log", join(logs, "inject.log")];
	const hit = waitFor((m) => m.kind === "ctrl+l", 15000).then(() => log("ctrl+l HANDLER FIRED")).catch(() => log("ctrl+l handler did not fire"));
	await new Promise((r) => spawn("pwsh", a, { stdio: "ignore" }).on("exit", r));
	await hit;
	await sleep(1500);
	tx({ type: "overlay", open: false });
	await sleep(500);
	tx({ type: "shutdown" });
} else if (scenario === "seed") {
	log("== Q8 seeded context + Q7 autonomous subagent_done");
	tx({ type: "task", text: "What is the secret codename mentioned in the context above? Call the subagent_done tool with summary set to exactly that codename." });
	const done = await waitFor((m) => m.type === "done", 300000);
	log("DONE summary:", done.summary);
}

const exitFile = `${launchFile}.exit.json`;
for (let i = 0; i < 120 && !existsSync(exitFile); i++) await sleep(500);
log("exit.json:", existsSync(exitFile) ? readFileSync(exitFile, "utf8") : "MISSING");
server.close();
