/**
 * Building `wt.exe` command lines. Pure functions, unit-tested.
 *
 * Getting an arbitrary argv through Windows Terminal to the child process
 * takes three layers of encoding (all verified against WT 1.24, see
 * test/unit/wt-args.test.ts and the argv probe in docs/window-backend.md):
 *
 * 1. Node quotes every element of `spawn("wt.exe", argv)` with the usual
 *    MSVCRT rules, and wt.exe splits its command line back into the same
 *    elements (CommandLineToArgvW). Nothing to do for us.
 * 2. Before parsing, wt splits *every* element at each `;` into separate
 *    commands (`new-tab ... ; split-pane ...`). A `;` directly preceded by a
 *    backslash is kept, and that one backslash is removed. So we insert one
 *    backslash before every `;` in every element (`\;` in the input becomes
 *    `\\;`, which wt turns back into `\;`).
 * 3. wt rebuilds the child command line from the elements after `--` by
 *    joining them with spaces and wrapping an element in plain double quotes
 *    if it contains a space, without escaping anything inside. We therefore
 *    pre-quote each child argument with MSVCRT rules ourselves and strip the
 *    outer quotes again when wt is going to add them.
 */

export interface WtLaunchOptions {
  /** Name for `wt -w <name>`; a new window is created when no window has this name. */
  windowName: string;
  /** Tab title (also the HWND caption while this tab is active). */
  title: string;
  /** Keep the title even if the application sets its own (OSC 0/2). Default true. */
  suppressApplicationTitle?: boolean;
  /** Tab colour, `#rrggbb`. */
  tabColor?: string;
  /** Starting directory. */
  cwd?: string;
  /** Initial outer window position in physical pixels (`--pos x,y`). */
  pos?: { x: number; y: number };
  /** Initial size in character cells (`--size cols,rows`). */
  size?: { cols: number; rows: number };
  /** Executable to run in the tab. */
  command: string;
  args?: readonly string[];
}

/**
 * Quote one argument so that CommandLineToArgvW / the MSVCRT parser yields it
 * unchanged. Arguments without whitespace or quotes are returned as they are.
 */
export function quoteWindowsArg(arg: string): string {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      // Escape the preceding backslashes and the quote itself.
      out += "\\".repeat(backslashes * 2 + 1) + '"';
    } else {
      out += "\\".repeat(backslashes) + ch;
    }
    backslashes = 0;
  }
  // Backslashes before the closing quote must be doubled.
  return out + "\\".repeat(backslashes * 2) + '"';
}

/** Escape every `;` so wt does not treat it as a command separator. */
export function escapeWtSemicolons(value: string): string {
  return value.replaceAll(";", "\\;");
}

/**
 * Encode one argument of the child command so that, after wt's re-joining
 * (layer 3 above), the child sees exactly `arg`.
 */
export function encodeChildArg(arg: string): string {
  const quoted = quoteWindowsArg(arg);
  // wt wraps elements containing a space in quotes itself; give it the inside.
  const element = arg.includes(" ") ? quoted.slice(1, -1) : quoted;
  return escapeWtSemicolons(element);
}

/** Reject values wt cannot carry unchanged. */
function assertCarriable(what: string, value: string): void {
  // NUL cannot be part of a Windows command line; CR/LF would end up as
  // literal line breaks in the tab's command line, which conpty mangles.
  if (/[\0\r\n]/.test(value)) throw new Error(`${what} must not contain NUL or line breaks: ${JSON.stringify(value)}`);
  // wt runs ExpandEnvironmentStrings over the rebuilt command line and the
  // starting directory, and there is no escape for it. Pass such values in a
  // file (the launcher's --pi-dogs-launch file) instead.
  if (/%[^%]+%/.test(value)) {
    throw new Error(`${what} must not contain %NAME% (wt would expand it): ${JSON.stringify(value)}`);
  }
}

/** Build the argv for `spawn("wt.exe", argv)`. */
export function buildWtArgs(options: WtLaunchOptions): string[] {
  const { windowName, title, command } = options;
  if (!/^[A-Za-z0-9_.-]+$/.test(windowName)) {
    // Also excludes numbers-only names, which wt interprets as window ids.
    throw new Error(`window name must be [A-Za-z0-9_.-]+: ${JSON.stringify(windowName)}`);
  }
  if (/^\d+$/.test(windowName)) throw new Error(`window name must not be numeric: ${windowName}`);
  if (!command) throw new Error("command must not be empty");
  if (/[\0\r\n]/.test(title)) throw new Error(`title must not contain NUL or line breaks: ${JSON.stringify(title)}`);
  assertCarriable("cwd", options.cwd ?? "");
  assertCarriable("command", command);
  for (const arg of options.args ?? []) assertCarriable("argument", arg);
  if (options.tabColor !== undefined && !/^#[0-9a-fA-F]{6}$/.test(options.tabColor)) {
    throw new Error(`tabColor must be #rrggbb: ${options.tabColor}`);
  }

  const argv: string[] = ["-w", windowName];
  if (options.pos) {
    const { x, y } = options.pos;
    if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error(`pos must be integers: ${x},${y}`);
    argv.push("--pos", `${x},${y}`);
  }
  if (options.size) {
    const { cols, rows } = options.size;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
      throw new Error(`size must be positive integers: ${cols},${rows}`);
    }
    argv.push("--size", `${cols},${rows}`);
  }
  argv.push("new-tab", "--title", escapeWtSemicolons(title));
  if (options.suppressApplicationTitle ?? true) argv.push("--suppressApplicationTitle");
  if (options.tabColor) argv.push("--tabColor", options.tabColor);
  if (options.cwd) argv.push("-d", escapeWtSemicolons(options.cwd));
  argv.push("--", encodeChildArg(command), ...(options.args ?? []).map(encodeChildArg));
  return argv;
}

/**
 * The command line the child process will receive, as wt rebuilds it from
 * the encoded elements. Used by tests to check the encoding round trip.
 */
export function simulateWtChildCommandLine(wtArgv: readonly string[]): string {
  const dashDash = wtArgv.indexOf("--");
  if (dashDash < 0) throw new Error("no -- in argv");
  const unescape = (element: string) => element.replace(/\\;/g, ";");
  return wtArgv
    .slice(dashDash + 1)
    .map(unescape)
    .map((element) => (element.includes(" ") ? `"${element}"` : element))
    .join(" ");
}

/** Split a command line the way CommandLineToArgvW does (for tests; post-2008 rules). */
export function parseWindowsCommandLine(commandLine: string): string[] {
  const args: string[] = [];
  let i = 0;
  const n = commandLine.length;
  while (i < n) {
    while (i < n && (commandLine[i] === " " || commandLine[i] === "\t")) i++;
    if (i >= n) break;
    let arg = "";
    let inQuotes = false;
    while (i < n) {
      const ch = commandLine[i]!;
      if (!inQuotes && (ch === " " || ch === "\t")) break;
      if (ch === "\\") {
        let count = 0;
        while (commandLine[i] === "\\") {
          count++;
          i++;
        }
        if (commandLine[i] === '"') {
          arg += "\\".repeat(Math.floor(count / 2));
          if (count % 2 === 1) {
            arg += '"';
            i++;
          }
        } else {
          arg += "\\".repeat(count);
        }
        continue;
      }
      if (ch === '"') {
        if (inQuotes && commandLine[i + 1] === '"') {
          arg += '"';
          i += 2;
          continue;
        }
        inQuotes = !inQuotes;
        i++;
        continue;
      }
      arg += ch;
      i++;
    }
    args.push(arg);
  }
  return args;
}
