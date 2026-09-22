// Node + koffi version of the tiling helper (what the pi extension would use in-process).
// Usage: node wtile-koffi.mjs find <title> | place <title> x y w h [...]
// Needs `koffi` resolvable (NODE_PATH or local node_modules).
import { createRequire } from 'node:module';
const t0 = performance.now();
const require = createRequire(import.meta.url);
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
const dwm = koffi.load('dwmapi.dll');
const RECT = koffi.struct('RECT', { L: 'int', T: 'int', R: 'int', B: 'int' });
const MONITORINFO = koffi.struct('MONITORINFO', { cb: 'uint32', mon: RECT, work: RECT, flags: 'uint32' });
const EnumProc = koffi.proto('bool __stdcall EnumProc(void *h, intptr_t p)');
const EnumWindows = user32.func('bool __stdcall EnumWindows(EnumProc *cb, intptr_t p)');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(void *h, _Out_ uint16_t *s, int n)');
const GetClassNameW = user32.func('int __stdcall GetClassNameW(void *h, _Out_ uint16_t *s, int n)');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void *h, _Out_ RECT *r)');
const MonitorFromWindow = user32.func('void * __stdcall MonitorFromWindow(void *h, uint32 f)');
const GetMonitorInfoW = user32.func('bool __stdcall GetMonitorInfoW(void *m, _Inout_ MONITORINFO *mi)');
const GetDpiForWindow = user32.func('uint32 __stdcall GetDpiForWindow(void *h)');
const SetProcessDpiAwarenessContext = user32.func('bool __stdcall SetProcessDpiAwarenessContext(intptr_t v)');
const BeginDeferWindowPos = user32.func('void * __stdcall BeginDeferWindowPos(int n)');
const DeferWindowPos = user32.func('void * __stdcall DeferWindowPos(void *d, void *h, void *after, int x, int y, int cx, int cy, uint32 f)');
const EndDeferWindowPos = user32.func('bool __stdcall EndDeferWindowPos(void *d)');
const DwmGetWindowAttribute = dwm.func('int __stdcall DwmGetWindowAttribute(void *h, uint32 a, _Out_ RECT *r, uint32 s)');
SetProcessDpiAwarenessContext(-4); // per-monitor v2, so all numbers are physical pixels
const tLoad = performance.now() - t0;

const str = (buf, n) => String.fromCharCode(...buf.slice(0, n));
function find(title) {
  let found = null; const b = new Uint16Array(256);
  const cb = koffi.register((h) => {
    const n = GetClassNameW(h, b, 256);
    if (str(b, n) !== 'CASCADIA_HOSTING_WINDOW_CLASS') return true;
    const m = GetWindowTextW(h, b, 256);
    if (str(b, m) === title) { found = h; return false; }
    return true;
  }, koffi.pointer(EnumProc));
  EnumWindows(cb, 0); koffi.unregister(cb); return found;
}
const [cmd, ...a] = process.argv.slice(2);
const t1 = performance.now();
if (cmd === 'find') {
  const h = find(a[0]); if (!h) { console.log('notfound'); process.exit(1); }
  const r = {}, f = {}; GetWindowRect(h, r); DwmGetWindowAttribute(h, 9, f, 16);
  const mi = { cb: koffi.sizeof(MONITORINFO), mon: {}, work: {}, flags: 0 }; GetMonitorInfoW(MonitorFromWindow(h, 2), mi);
  console.log(JSON.stringify({ rect: r, frame: f, work: mi.work, dpi: GetDpiForWindow(h), loadMs: +tLoad.toFixed(1), opMs: +(performance.now() - t1).toFixed(2) }));
} else if (cmd === 'place') {
  const items = [];
  for (let i = 0; i + 4 < a.length; i += 5) {
    const h = find(a[i]); if (!h) continue; const [x, y, w, hh] = a.slice(i + 1, i + 5).map(Number);
    const r = {}, f = {}; GetWindowRect(h, r); DwmGetWindowAttribute(h, 9, f, 16);
    const l = f.L - r.L, t = f.T - r.T, rr = r.R - f.R, b = r.B - f.B;
    items.push([h, x - l, y - t, w + l + rr, hh + t + b]);
  }
  let d = BeginDeferWindowPos(items.length);
  for (const [h, x, y, w, hh] of items) d = DeferWindowPos(d, h, null, x, y, w, hh, 0x14);
  EndDeferWindowPos(d);
  console.log(JSON.stringify({ placed: items.length, loadMs: +tLoad.toFixed(1), opMs: +(performance.now() - t1).toFixed(2) }));
}
