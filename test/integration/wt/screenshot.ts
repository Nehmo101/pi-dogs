// Screenshots for the Windows Terminal integration test.
//
// PrintWindow cannot be used: for inactive Windows Terminal windows it returns
// a black bitmap (WT renders through DirectComposition). So we raise *our*
// windows to the top of the z-order (without activating them), copy the
// screen, and keep only the pixels inside our windows' visible frames. The
// rest of the image is a plain background, so nothing else the user has open
// can end up in a screenshot. Needs the interactive desktop (run.ts takes
// care of that by running the host inside Windows Terminal).

import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";

import type { Rect } from "../../../src/layout/computeLayout.ts";
import type { Hwnd, Win32 } from "../../../src/backend/windows-terminal/win32.ts";

type Koffi = typeof import("koffi");

interface Gdi {
  /** BGRA pixels of a screen rectangle, top-down. */
  copyScreen(area: Rect): Buffer | undefined;
  raise(hwnd: Hwnd): void;
  /** Top-level window that is on screen at a point. */
  topLevelAt(x: number, y: number): Hwnd;
}

let gdi: Gdi | undefined;

function loadGdi(): Gdi {
  if (gdi) return gdi;
  const koffi = createRequire(import.meta.url)("koffi") as Koffi;
  const user32 = koffi.load("user32.dll");
  const gdi32 = koffi.load("gdi32.dll");
  const suffix = `_pidogs_shot_${process.pid}`;
  const BITMAPINFOHEADER = koffi.struct(`BITMAPINFOHEADER${suffix}`, {
    biSize: "uint32",
    biWidth: "int32",
    biHeight: "int32",
    biPlanes: "uint16",
    biBitCount: "uint16",
    biCompression: "uint32",
    biSizeImage: "uint32",
    biXPelsPerMeter: "int32",
    biYPelsPerMeter: "int32",
    biClrUsed: "uint32",
    biClrImportant: "uint32",
  });
  const H = "intptr_t";
  const f = (lib: typeof user32, name: string, result: string, args: unknown[]) =>
    lib.func("__stdcall", name, result, args as Parameters<typeof lib.func>[3]);
  const GetDC = f(user32, "GetDC", H, [H]);
  const ReleaseDC = f(user32, "ReleaseDC", "int", [H, H]);
  const SetWindowPos = f(user32, "SetWindowPos", "bool", [H, H, "int", "int", "int", "int", "uint32"]);
  const POINT = koffi.struct(`POINT${suffix}`, { x: "int32", y: "int32" });
  const WindowFromPoint = f(user32, "WindowFromPoint", H, [POINT]);
  const GetAncestor = f(user32, "GetAncestor", H, [H, "uint32"]);
  const CreateCompatibleDC = f(gdi32, "CreateCompatibleDC", H, [H]);
  const CreateCompatibleBitmap = f(gdi32, "CreateCompatibleBitmap", H, [H, "int", "int"]);
  const SelectObject = f(gdi32, "SelectObject", H, [H, H]);
  const BitBlt = f(gdi32, "BitBlt", "bool", [H, "int", "int", "int", "int", H, "int", "int", "uint32"]);
  const DeleteObject = f(gdi32, "DeleteObject", "bool", [H]);
  const DeleteDC = f(gdi32, "DeleteDC", "bool", [H]);
  const GetDIBits = f(gdi32, "GetDIBits", "int", [
    H, H, "uint32", "uint32", "void *", koffi.inout(koffi.pointer(BITMAPINFOHEADER)), "uint32",
  ]);
  const SRCCOPY = 0x00cc0020;
  const HWND_TOP = 0;
  const SWP_NOSIZE_NOMOVE_NOACTIVATE_NOOWNERZORDER = 0x1 | 0x2 | 0x10 | 0x200;

  gdi = {
    topLevelAt(x, y) {
      const h = WindowFromPoint({ x, y });
      return h ? GetAncestor(h, 2 /* GA_ROOT */) : 0;
    },
    raise(hwnd) {
      SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOSIZE_NOMOVE_NOACTIVATE_NOOWNERZORDER);
    },
    copyScreen(area) {
      const screen = GetDC(0);
      const dc = CreateCompatibleDC(screen);
      const bitmap = CreateCompatibleBitmap(screen, area.width, area.height);
      const old = SelectObject(dc, bitmap);
      try {
        if (!BitBlt(dc, 0, 0, area.width, area.height, screen, area.x, area.y, SRCCOPY)) return undefined;
        SelectObject(dc, old);
        const pixels = Buffer.alloc(area.width * area.height * 4);
        const header = {
          biSize: 40, biWidth: area.width, biHeight: -area.height, biPlanes: 1, biBitCount: 32, biCompression: 0,
          biSizeImage: 0, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0,
        };
        return GetDIBits(dc, bitmap, 0, area.height, pixels, header, 0) === area.height ? pixels : undefined;
      } finally {
        DeleteObject(bitmap);
        DeleteDC(dc);
        ReleaseDC(0, screen);
      }
    },
  };
  return gdi;
}

/** Encode 24-bit RGB pixels as PNG. */
export function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body) >>> 0, body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8 bit, RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Save a picture of `area` that shows only the given windows (their visible
 * frames). Returns false if the screen could not be copied.
 */
export async function saveComposite(win32: Win32, windows: readonly Hwnd[], area: Rect, path: string): Promise<boolean> {
  const g = loadGdi();
  const frames: { hwnd: Hwnd; frame: Rect }[] = [];
  for (const hwnd of windows) {
    if (!win32.isWindow(hwnd) || win32.isIconic(hwnd) || !win32.isWindowVisible(hwnd)) continue;
    const frame = win32.getFrameBounds(hwnd);
    if (!frame) continue;
    g.raise(hwnd);
    frames.push({ hwnd, frame });
  }
  if (frames.length === 0) return false;
  await new Promise((r) => setTimeout(r, 250)); // let DWM compose the new z-order
  // Privacy guard: every sampled point inside a frame must belong to that
  // window. If anything else is on top (e.g. an always-on-top window of the
  // user), refuse to save rather than capture it.
  for (const { hwnd, frame } of frames) {
    for (let i = 1; i <= 7; i++) {
      for (let j = 1; j <= 7; j++) {
        const x = frame.x + Math.floor((frame.width * i) / 8);
        const y = frame.y + Math.floor((frame.height * j) / 8);
        if (g.topLevelAt(x, y) !== hwnd) return false;
      }
    }
  }
  const screen = g.copyScreen(area);
  if (!screen) return false;
  const canvas = Buffer.alloc(area.width * area.height * 3, 0x18); // dark grey background
  for (const { frame } of frames) {
    for (let y = Math.max(frame.y, area.y); y < Math.min(frame.y + frame.height, area.y + area.height); y++) {
      for (let x = Math.max(frame.x, area.x); x < Math.min(frame.x + frame.width, area.x + area.width); x++) {
        const s = ((y - area.y) * area.width + (x - area.x)) * 4;
        const d = ((y - area.y) * area.width + (x - area.x)) * 3;
        canvas[d] = screen[s + 2]!;
        canvas[d + 1] = screen[s + 1]!;
        canvas[d + 2] = screen[s]!;
      }
    }
  }
  writeFileSync(path, encodePng(area.width, area.height, canvas));
  return true;
}
