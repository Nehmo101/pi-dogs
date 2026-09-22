// Strip ANSI from a PI_TUI_WRITE_LOG capture and search it. Usage: node tui-grep.mjs <log> <regex>...
import { readFileSync } from "node:fs";
const [file, ...pats] = process.argv.slice(2);
const raw = readFileSync(file, "utf8");
const s = raw.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "");
for (const p of pats) {
	const re = new RegExp(p, "g");
	const hits = [...s.matchAll(re)];
	console.log(`/${p}/ hits=${hits.length}`, hits.length ? JSON.stringify(hits[0][0].slice(0, 400)) : "");
}
