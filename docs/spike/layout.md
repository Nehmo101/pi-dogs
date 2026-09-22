# Phase 0 layout spike: panes (A) vs. tiled windows (B)

Date: 2026-09-23. Scope: PLAN.md sections 4 and 13. Everything below was measured on this machine unless it is marked as an inference.

## Test environment

| Item | Value |
|---|---|
| OS | Windows 11 Pro 10.0.26200, RDP session (user `uwe-rdp`, real desktop) |
| Monitor | one monitor, **3440 × 1440**, work area **3440 × 1392** (48 px taskbar), **96 DPI (100 %)** from `GetDpiForWindow` |
| Windows Terminal | 1.24.11911.0, default settings (Cascadia Mono 12 pt, `closeOnExit` = automatic) |
| Cell size (measured) | about **9 px per column** and **19 px per row** at 100 % |
| Window chrome (B, measured) | about 36 px horizontally and 56 px vertically per WT window (tab row about 40 px, padding, scrollbar) |
| Invisible resize borders | L/T/R/B = **7/0/7/7 px** (`GetWindowRect` compared with `DWMWA_EXTENDED_FRAME_BOUNDS`) |

Rule of thumb for `computeLayout` (B, 100 %): `cols ≈ floor((w − 36) / 9)`, `rows ≈ floor((h − 56) / 19)`. At other scales the values scale with DPI. We did not measure other scales (see Risks).

Sandbox note: the agent sandbox has no input-desktop access (`GetForegroundWindow()` returns 0 and `CopyFromScreen` fails). So all focus checks and screenshots ran through `spike/layout/Invoke-Desk.ps1`, which runs the script in a throwaway WT window that moves itself off-screen. This does not affect production, because pi runs inside WT on the real desktop. `SetWindowPos` works from inside the sandbox as well.

## Approach A: panes in one WT window (checked briefly)

| Capability | Result | Exact command / evidence |
|---|---|---|
| Split with size, title, cwd | **works** | `wt -w pi-dogs-spikeA split-pane -V --size 0.5 --title pd-sub1 --suppressApplicationTitle --tabColor "#d5533a" -d %USERPROFILE% -- pwsh -File pane.ps1 …` (wt returns in 64 ms, pane process runs about 0.8 s later) |
| Equal heights for 1..4 stacked panes | **only at creation**: split the newest pane with `--size (n−k+1)/(n−k+2)`, i.e. `-H --size 0.75`, then `0.6667`, then `0.5`. The result was 4 × 16 rows. | `A-6-main+4sub-equal-precomputed.png` |
| Adding a pane later with equal heights | **doesn't work**: splitting halves the focused pane, so 2 equal panes plus one more gives 1/2, 1/4, 1/4 (34/16/16 rows) | `A-3-incremental-unequal.png` |
| Resize existing panes from the CLI | **doesn't work**: `wt` has no resize subcommand (`resizePane` exists only as a key-binding action) | – |
| Middle pane exits | **partially**: its sibling in the split tree takes all the space, and nothing is redistributed evenly | `A-4-after-middle-exit.png` |
| `focus-pane --target <id>` | **works**: ids are in creation order (0 = main) | `wt -w pi-dogs-spikeA focus-pane --target 2` |
| `move-focus up`, `swap-pane down` | **works** / runs without error (swap was not checked visually) | `wt -w pi-dogs-spikeA move-focus up` |
| `move-pane --tab 1` (park the focused pane) | **works**: the pane moves to a new tab and gets the full size there | `wt -w pi-dogs-spikeA move-pane --tab 1`, `A-5-after-move-pane.png` |
| Move the pane back (`move-pane --tab 0`) | **not confirmed**: in one run, all commands sent to the named window went instead to a *new* default window (a stray "Windows PowerShell" window appeared). Two re-runs could not reproduce it (`A-test3.ps1`). This is flaky and a risk for any CLI-driven design. | `A-test2.ps1` |
| Splitting steals focus | **yes, inside the window**: the new pane becomes the focused pane (window title switches to it). A later `focus-pane --target 0` brings the focus back. | window title = focused pane title |
| New pane lands in the right window while another WT window is focused | **works** (the pane appeared in `pi-dogs-spikeA`) | `A-5b-split-while-other-window-focused.png` |
| Environment variables inherited from the caller | **YES, which contradicts PLAN §4.** A variable set by the caller (`PIDOGS_ENVTEST=from-caller`) was visible in the split pane (WT 1.24). Keep passing hub data by flag or file anyway: this is not documented as a guarantee. | `state/sub1.env` showed `[from-caller]` |
| Per-pane title and colour | **doesn't work**: panes have no title bars. The tab shows only the *focused* pane's title and colour, so you cannot tell which agent a pane belongs to. | all A screenshots |
| Pitfall: `;` | wt treats a bare `;` as a command separator, so `pwsh -Command "a; b"` turns into extra broken tabs. Escape it (`\;`) or use `-File`. | first attempt created 2 broken tabs |
| Pitfall: `closeOnExit` | A pane or window closes only when the process exits with code 0. A crash or kill leaves a "process exited" pane behind. | `pane.ps1` always exits 0 |
| Pitfall: closing a WT window externally | `WM_CLOSE` and `SC_CLOSE` to the WT window were **ignored**. The only clean way to close it is to let its process exit. | – |

Verdict A: A cannot keep equal sizes once agents come and go, cannot resize, and cannot show which agent is in which pane. That fails "looks good" and "fluid" as soon as the number of agents changes.

## Approach B: one WT window per agent, tiled via Win32

### Findings per capability

| Capability | Result | Exact command / evidence |
|---|---|---|
| Open named window | **works**: `wt.exe` returns in 58–281 ms | `wt -w pi-dogs-spikeB-a1 new-tab --title pd-a1 --suppressApplicationTitle --tabColor "#d5533a" -- pwsh -File pane.ps1 -Name a1` |
| Reliable HWND discovery | **works, 20/20 windows**: enumerate `CASCADIA_HOSTING_WINDOW_CLASS`, keep only HWNDs that did not exist before the launch, and match the unique tab title (`--suppressApplicationTitle` stops the app from overwriting the title). Found **230–640 ms** after the call (typically about 400 ms). All WT windows share **one** `WindowsTerminal.exe` process, so a process-tree lookup does *not* work. | `B-lib.ps1 Open-Agent` |
| Work area, DPI | **works**: `MonitorFromWindow` + `GetMonitorInfo.rcWork` gave 0,0 3440×1392; `GetDpiForWindow` gave 96. The helper is per-monitor-v2 DPI aware, so all values are physical pixels. | `Win32Layout.ps1` |
| Flush tiling (no gaps) | **works, 0 px error in every layout**: compensate using the DWM extended frame bounds (7/0/7/7) and position the *visible* frame | `Test-Flush` → `flushErr=0px` for all 21 layouts |
| Apply a layout | **works**: `BeginDeferWindowPos` / `DeferWindowPos` / `EndDeferWindowPos` for all windows takes **4–32 ms** | `Set-Layout` |
| Smoothness | **good with DeferWindowPos**: the new geometry shows in one composed frame (≤ 167 ms). One capture at 95 ms showed wallpaper for a moment where a region was not yet covered. Sequential `SetWindowPos` shows windows moving one after another (`B-smooth-seq.png`). `SWP_NOREDRAW` is **bad**: stale pixels of other windows stay visible (`B-smooth-defer-noredraw.png`). `SWP_ASYNCWINDOWPOS` looks the same as plain defer. | `B-smooth-*.png` (8 frames about 65 ms apart) |
| pi repaint after resize | **works**: pi had fully redrawn at the new size within 300 ms | `B-pi-redraw-0300ms.png` |
| Re-tile when a window closes | **works**: the window is gone 241 ms after the process exits with code 0. The gap stays until we re-tile, then the rest get equal sizes (4 → 3 equal, 187×21 each). | `B-retile-0-gap-after-close.png`, `B-retile-1-after.png` |
| Minimize / restore | **works**: `ShowWindow(SW_MINIMIZE)` minimizes. `ShowWindow(SW_SHOWNOACTIVATE)` restores to the exact previous frame **without taking focus**. `SW_RESTORE` also activates the window. | `B-test.ps1` |
| Initial position at launch | **works**: `wt -w … --pos 2600,700 new-tab …` gave a visible frame at exactly x=2600 (window rect at 2593 because of the 7 px border). Launching at the final spot avoids the flash at the default cascade position (148,156 +26 px per window). | `B-test2.ps1` |
| Focus stealing | **yes**: every new WT window takes the foreground. `SetForegroundWindow(main)` right afterwards returned True and worked, when called from a console process running inside a WT window (same situation as the pi process). | `B-test2.ps1` |
| Focus mode (no tab row, +2 rows) | **partially**: `wt -f -w <name> new-tab …` works and saves 40 px. `--focusMode` (long form) failed with an "argument not expected" dialog. It also hides the coloured title tab, which we want for agent identity. | `B-test3.ps1` |
| Multi-monitor / other DPI | **not testable here** (one monitor at 100 %). The code path is per-monitor aware; see Risks. | – |

### Readable size per layout (measured, cols × rows per window)

The main window is on the left in every layout. The targets from PLAN §13 are **sub ≥ 80 cols × 16 rows, main ≥ 100 cols**. Values that miss a target are in *italics*.

| Sub agents | Stacked (one right column), main 50 % | Columns (full height, beside main) | Best measured choice |
|---|---|---|---|
| 1 | main 187×70, sub 187×70 (`B-stacked-1.png`) | same (`B-columns-1.png`) | 50/50 |
| 2 | main 187×70, subs 187×33 (`B-stacked-2.png`) | main 50 %: subs 91×70 (`B-columns-2.png`); main 40 %: main 149×70, subs **110×70** | **columns, main 40 %** |
| 3 | main 187×70, subs 187×21 (`B-stacked-3.png`, `B-pi-stacked-3.png`) | main 50 %: *59×70*; main 40 %: *72×70*; main 35 %: *79×70*; main 33 %: main 122×70, subs **81×70** (`B-columns-3-main33.png`, `B-pi-columns-3-main33.png`); main 30 %: main 110, subs 85×70 | **columns, main 33 %** |
| 4 | main 187×70, subs 187×*15* (`B-stacked-4.png`) | 4 columns, main 30 %: *63×70* (`B-columns-4-4cols-main30.png`); **2 × 2 grid**, main 40 %: main 149×70, subs **110×33** (`B-columns-4.png`, `B-pi-columns-4-2x2-main40.png`) | **2 × 2 grid, main 40 %** |
| 5 | 2 columns (3 + 2), main 50 %: 91×21 / 91×33 | 2 rows (3 + 2), main 40 %: *72×33* / 110×33 | 2 rows of columns, main ≈ 30 % (inference: ≈ 85×33) |
| 6 | 2 columns × 3, main 50 %: 91×21 (`B-stacked-6-2cols.png`); main 40 %: 110×21 (`B-stacked-6-2cols-main40.png`) | 2 rows × 3, main 40 %: *72×33* (`B-columns-6-2rows-main40.png`); main 50 %: *59×33* | 3 × 2 grid, main 30 % (inference from the formula: main ≈ 110, subs ≈ 85×33) |

Equal-width columns including main: main and subs 123×70 with 2 subs, but only 91 cols with 3 subs (main below 100). This option was not better than a narrower main (`B-equalcols-*.png`).

**Stacked vs. columns verdict:** full-height columns are clearly more readable. pi's output is mostly tall: code blocks, tool logs and the editor/footer take up about 8 of the rows. A 21-row stacked window shows only a few lines of the answer. An 81×70 column shows a whole class definition (compare `B-pi-stacked-3.png` with `B-pi-columns-3-main33.png`). Columns drop below 80 cols once there are 4 of them, even on this 3440 px ultrawide. From there, a grid with 2 rows of columns (33 rows each) beats both 4 narrow columns and a 15-row stack. On a 1920 px wide monitor (inference from the formula), only 1 full-height column fits next to a 100-col main, so the grid fallback (or the second monitor) starts at 2 agents.

Suggested rule for `computeLayout`: keep main at ≥ 100 cols. Place k = the largest number of full-height columns that are each ≥ 80 cols. If there are more agents than k, use 2 rows of columns (≥ 16 rows each, in practice 33). If that still does not fit, minimize the oldest agent or use the next monitor. Take the cell size from the real font and DPI.

### Latency of the helper (median of 5 runs: find a window, or find and place 2 windows)

| Option | Per call | Notes |
|---|---|---|
| PowerShell + `Add-Type` C# | **≈ 1 770 ms** | Compiles on every start. Fine for the spike, not for production. |
| .NET 10 console exe (JIT) | ≈ 160 ms | – |
| .NET 10 **NativeAOT** exe | **≈ 33 ms** (find), 38 ms (place 2) | The build needs the VS Build Tools linker. The first attempt failed until `vswhere.exe` was on PATH. |
| Node + **koffi** 3.3.1 as a separate process | ≈ 160–190 ms | Mostly Node startup (about 108 ms without doing anything) |
| Node + koffi **in the pi process** | koffi load **21–28 ms once**, then find 1.5 ms and place 2 windows 3.3 ms | Measured inside the script (`loadMs` and `opMs`) |

Production choice: **koffi inside the pi extension** (no child process, about 2–3 ms per re-tile, all in TypeScript). Fallback: a NativeAOT `wtile.exe` (source in `spike/layout/wtile-dotnet`), if a native npm dependency turns out to be a problem for `pi install`. npm printed an `allow-scripts` warning for koffi, but the prebuilt binary loaded without any install script.

## Recommendation: **B**, with one colour-titled WT window per agent

It ties back to the three goals like this:

- **Looks good:** pixel-exact, flush tiles (0 px error), equal sizes in every configuration, and each agent's own coloured tab showing its name. A can only give equal sizes when all panes are created in one go, and it shows only one title per tab.
- **Readable:** we choose the arrangement for each agent count (columns → grid) and keep ≥ 80×33 per sub agent up to 6 agents on this monitor. A is limited to halving the split tree (1/2, 1/4, 1/4 …).
- **Fluid:** re-tiling is one `DeferWindowPos` batch (≤ 32 ms to apply, about 1 composed frame on screen), pi repaints within 300 ms, and closed agents are re-tiled evenly. A cannot resize at all.
- Extras from B: real minimize and restore without taking focus (`SW_SHOWNOACTIVATE`), and a second monitor is possible.

Hybrid element worth keeping: the **main pi is also a named WT window** (`wt -w pi-dogs-<hub>` via a `pi-wt` launcher, or by adopting the current window through its title) so that pi-dogs can place it on the left.

Implementation notes from the spike:
1. Launch with `--pos <x−7>,<y>` at the final spot, then find the HWND with "new HWND + unique title", then run one `DeferWindowPos` for all windows.
2. After every launch, give the foreground back to main (`SetForegroundWindow`). If that fails, fall back to `wt -w <main> focus-tab -t 0`.
3. The sub-pi wrapper must always exit with code 0 (otherwise `closeOnExit` leaves a dead window), and command lines must not contain a bare `;`.
4. Never use `SWP_NOREDRAW`. Use `SW_SHOWNOACTIVATE` for restore.
5. Match windows by HWND only after discovery. Titles can change if `--suppressApplicationTitle` is ever dropped.

## Risks

- **DPI and multi-monitor were not tested** (one 100 % monitor here). Moving a window across monitors with different DPI triggers `WM_DPICHANGED` and WT rescales the window itself. Placing it *twice* (move, then size) is likely needed. Test on a 125 %/150 % machine in Phase 1.
- **Focus stealing** on every new window. Handing focus back worked here, but Windows foreground-lock rules can refuse it (for example, when the user is typing in another application). The user sees the main window lose focus for a moment.
- **Flaky name targeting:** once, `wt -w <existing name>` commands opened a new window instead of reaching the named one. B uses `-w` only to create windows, so a failure is easy to detect (the expected title does not appear), but it needs a timeout and a retry.
- The user's own windows can cover the tiles. We do not force z-order (and should not). Screenshots taken during the spike sometimes showed the owner's windows on top.
- Every B window has its own tab row (about 2 rows fewer than a pane). Focus mode (`-f`) gets those rows back but hides the name and colour.

## Files

- Screenshots: `docs/spike/screens/` (A-*.png, B-*.png, B-smooth-*.png are 8-frame montages)
- Scripts: `spike/layout/` (paths are relative to the scripts): `Win32Layout.ps1` (Win32 via Add-Type), `B-lib.ps1` (`Open-Agent`, `Get-Layout`, `Set-Layout`, `Test-Flush`), `pane.ps1` (agent stand-in that reports its cols×rows), `Invoke-Desk.ps1` + `desk-host.ps1` (run on the interactive desktop), `A-test*.ps1`, `B-test*.ps1`, `bench-helpers.ps1`, `wtile-koffi.mjs`, `wtile-dotnet/`
