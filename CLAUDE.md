# Glass — Claude overlay

Frameless, always-on-top liquid-glass Electron window that fronts the Anthropic Messages API, with native macOS tool integrations (Calendar, Reminders, Mail), Anki, Obsidian, weather, screenshot capture, and a per-app long-term memory store.

Single developer, single user, no CI, no tests.

## Layout

All app code lives under `overlay/`. The repo root is otherwise empty (this file + `.git/` + `.claude/`).

```
overlay/
  main.js              Electron main: BrowserWindow, global shortcut, all ipcMain handlers,
                       AppleScript builders + parsers, AnkiConnect, Open-Meteo, Obsidian MCP client.
  preload.js           contextBridge surface: window.{appleScripts, api, memory, mail, anki, weather, obsidian}.
  renderer/
    index.html         Layout (loads style.css + app.js as plain <script>).
    style.css          Liquid-glass styles.
    app.js             ~45 KB. Model picker, system prompt, tool schema, tool dispatcher,
                       streaming + tool-use loop, conversation state, transcript DOM, composer.
  ekhelper.swift       Native Calendar/Reminders helper (faster than osascript).
  ekhelper             Compiled + codesigned binary (committed; rebuilt by `npm run build:helper`).
  Glass.app/           AppleScript-wrapped launcher (built once via osacompile).
  Glass.iconset/       Source icons for the .app bundle.
  MEMORY_SYSTEM.md     Spec for the runtime memory store (separate from .claude memory).
  .env                 ANTHROPIC_API_KEY, OBSIDIAN_API_KEY. Never edit via Claude Code (blocked by hook).
  .env.example         Template.
```

## Run / build

```bash
cd overlay
npm install              # also runs `npm run build:helper` postinstall
npm start                # launches Electron with the renderer
npm run build:helper     # swiftc -O + codesign ekhelper; required after any ekhelper.swift edit
```

The launcher `.app` is built once and rarely:
```bash
osacompile -o Glass.app launcher.applescript
# then re-apply the custom icon from Glass.iconset/
```

## Runtime architecture invariants

- **Renderer is sandboxed.** `nodeIntegration: false`, `contextIsolation: true`. The renderer cannot `require` Node modules. Every privileged operation goes through an `ipcMain.handle` channel, exposed to `window.*` via `preload.js`. **Do not relax this.**
- **Preload is the contract.** Every new `ipcMain.handle('X:y', ...)` needs a matching narrow binding in `preload.js`. No generic passthroughs except `appleScripts.raw` (already exists, used by the renderer to run ad-hoc scripts the model composes).
- **Path safety for memory.** All memory file ops route through `resolveMemPath()` in `main.js`. It rejects `..`, requires `.md`, and asserts the resolved path stays inside the memory root. Do not bypass it. If you add another file-storage channel, use the same pattern.
- **AppleScript escaping.** Every user-supplied string interpolated into AppleScript MUST go through `escapeAS()`. The `build*` functions (`buildCreateEvent`, `buildSearchMail`, etc.) are the only place this happens — keep it that way.
- **Caching layer.** Read-shaped channels use `cachedRead(key, fn)` with a 60s TTL. Write-shaped channels call `cacheInvalidate(prefix)` afterwards. Match the pattern when adding similar channels.
- **MCP lifecycle.** The Obsidian MCP client (`initObsidianMCP`) is lazy-initialized on first use, kept as a process-wide singleton, and closed in `app.on('will-quit', ...)`. Any new MCP transport should follow the same shape.
- **Codesigned helper.** `ekhelper` must remain codesigned (`codesign --sign -`) or macOS will refuse to load it. The `build:helper` script does this; don't ship an unsigned binary.

## Models

Configured at the top of `renderer/app.js`:

- `MODEL_FAST = 'claude-haiku-4-5-20251001'` — default, used for short text-only turns.
- `MODEL_DEEP = 'claude-sonnet-4-6'` — used when input has an image, is long, looks like code, or matches debug/plan/research heuristics in `pickModel()`.
- User can force a model with a `/fast`, `/haiku`, `/deep`, or `/sonnet` prefix; `stripModelPrefix()` removes it before sending.

## Runtime memory (separate from .claude/memory)

The overlay app keeps its own long-term memory at `~/Library/Application Support/overlay/memory/` — a tree of markdown files (`memory.md` index, `general.md`, `domain/<topic>.md`, `tools/<tool>.md`). The renderer exposes five tools (`list_memory_files`, `read_memory`, `write_memory`, `append_memory`, `delete_memory`) backed by the `memory:*` IPC channels. Full spec: `overlay/MEMORY_SYSTEM.md`.

This is the **runtime overlay's memory** — the app's user-facing assistant uses it. It is unrelated to Claude Code's own auto-memory under `~/.claude/.../memory/`.

## Conventions

- No bundler in the renderer. New JS files load via `<script>` tags in `index.html`. ES module `<script type="module">` is fine if you need imports; CommonJS in the renderer is not.
- No tests, no linter, no formatter. Match the existing style: 2-space indent, single quotes, no semicolon-stripping, plain functions over classes.
- Don't add dependencies casually. Current runtime deps: `@modelcontextprotocol/sdk`, `dotenv`. Anything else needs a real reason.
- Don't narrate in the assistant UI. The system prompt instructs the model to be terse and never preamble; if you change the prompt, preserve that.

## Claude Code automation in this repo

- **Hook:** `Edit`/`Write` against `overlay/.env` is blocked (`.claude/settings.json`). The file holds live API keys; edit it manually.
- **Agents:** `ipc-security-reviewer` (audits new IPC channels), `renderer-refactor-scout` (maps seams in `renderer/app.js`). Invoke via the Agent tool.
