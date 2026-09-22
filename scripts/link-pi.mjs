#!/usr/bin/env node
// Make the pi packages resolvable for type checking without installing them.
//
// pi-dogs is loaded by pi, which provides `@earendil-works/pi-coding-agent`,
// `@earendil-works/pi-tui` and `typebox` at runtime. For `tsc` we only need
// their type declarations, so instead of installing the ~400 MB package tree
// this script links (directory junctions on Windows, symlinks elsewhere) the
// packages of the globally installed pi into ./node_modules.
//
// Lookup order for the pi package directory:
//   1. $PI_DOGS_PI_DIR (explicit override)
//   2. `npm root -g`/@earendil-works/pi-coding-agent
// Existing real directories in node_modules are left alone, so a regular
// `npm install @earendil-works/pi-coding-agent` also works.
import { execSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PI = "@earendil-works/pi-coding-agent";

function findPiDir() {
  if (process.env.PI_DOGS_PI_DIR) return resolve(process.env.PI_DOGS_PI_DIR);
  try {
    const npmRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
    return join(npmRoot, PI);
  } catch {
    return undefined;
  }
}

function link(name, target) {
  const dest = join(root, "node_modules", name);
  if (existsSync(dest)) {
    const stat = lstatSync(dest);
    if (!stat.isSymbolicLink()) return `kept   ${name} (installed)`;
    if (resolve(readlinkSync(dest)) === resolve(target)) return `ok     ${name}`;
    rmSync(dest, { recursive: false, force: true });
  }
  mkdirSync(dirname(dest), { recursive: true });
  symlinkSync(target, dest, "junction");
  return `linked ${name} -> ${target}`;
}

const piDir = findPiDir();
if (!piDir || !existsSync(join(piDir, "package.json"))) {
  console.error(
    `link-pi: could not find a global ${PI} installation.\n` +
      `Install pi (npm install -g ${PI}) or set PI_DOGS_PI_DIR to its package directory.`,
  );
  process.exit(1);
}

const packages = {
  [PI]: piDir,
  "@earendil-works/pi-tui": join(piDir, "node_modules", "@earendil-works", "pi-tui"),
  typebox: join(piDir, "node_modules", "typebox"),
};
for (const [name, target] of Object.entries(packages)) {
  if (!existsSync(target)) {
    console.error(`link-pi: ${name} not found at ${target}`);
    process.exit(1);
  }
  const msg = link(name, target);
  if (process.env.PI_DOGS_LINK_VERBOSE) console.log(`link-pi: ${msg}`);
}
