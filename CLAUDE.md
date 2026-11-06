# Glass — Claude overlay

Frameless, always-on-top liquid-glass Electron window that fronts the Anthropic Messages API, with native macOS tool integrations (Calendar, Reminders, Mail), Anki, Obsidian, weather, screenshot capture, and a per-app long-term memory store.

Single developer, single user, no CI, no tests.

## Layout

All app code lives under `overlay/`. The repo root holds only project docs (this file, `IDEAS.md`) + `.git/` + `.claude/`.

```
overlay/
  main.js              Electron main: BrowserWindow, global shortcut, all ipcMain handlers,
                       AppleScript builders + parsers, AnkiConnect, Open-Meteo, Nominatim/Overpass/OSM tiles,
                       Obsidian MCP client.
  preload.js           contextBridge surface: window.{appleScripts, api, memory, mail, anki, weather, obsidian, people, geo}.
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
  .env                 ANTHROPIC_API_KEY, OBSIDIAN_API_KEY, SPOTIFY_CLIENT_ID, DEEPGRAM_API_KEY. Never edit via Claude Code (blocked by hook).
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

## Feature backlog

Ideas we're considering live in `IDEAS.md` at the repo root (checked into git — this is a **dev roadmap**, distinct from both the runtime overlay memory and `.claude` memory). Each entry is stamped with the date and the commit HEAD at logging time.

```bash
cd overlay
npm run idea -- "Short title" "Optional description"   # auto-stamps date + short SHA
```

Before acting on an existing idea, run `git log <sha>..HEAD --oneline` with the entry's SHA to check what changed since — it may already be done or stale. Update each entry's `Status:` (`open` / `in progress` / `done` / `dropped`) by hand.

## Runtime architecture invariants

- **Renderer is sandboxed.** `nodeIntegration: false`, `contextIsolation: true`. The renderer cannot `require` Node modules. Every privileged operation goes through an `ipcMain.handle` channel, exposed to `window.*` via `preload.js`. **Do not relax this.**
- **Preload is the contract.** Every new `ipcMain.handle('X:y', ...)` needs a matching narrow binding in `preload.js`. No generic passthroughs except `appleScripts.raw` (already exists, used by the renderer to run ad-hoc scripts the model composes).
- **Path safety for memory.** All memory file ops route through `resolveMemPath()` in `main.js`. It rejects `..`, requires `.md`, and asserts the resolved path stays inside the memory root. Do not bypass it. If you add another file-storage channel, use the same pattern.
- **AppleScript escaping.** Every user-supplied string interpolated into AppleScript MUST go through `escapeAS()`. The `build*` functions (`buildCreateEvent`, `buildSearchMail`, etc.) are the only place this happens — keep it that way.
- **Caching layer.** Read-shaped channels use `cachedRead(key, fn)` with a 60s TTL. Write-shaped channels call `cacheInvalidate(prefix)` afterwards. Match the pattern when adding similar channels.
- **MCP lifecycle.** The Obsidian MCP client (`initObsidianMCP`) is lazy-initialized on first use, kept as a process-wide singleton, and closed in `app.on('will-quit', ...)`. Any new MCP transport should follow the same shape.
- **Obsidian MCP server is a pinned `uv tool` install, not `uvx`.** Set up once with:
  ```bash
  uv tool install mcp-obsidian --with 'mcp<2'
  ```
  `main.js` prefers `~/.local/bin/mcp-obsidian` (~1.8s to connect) and only falls back to `uvx --with 'mcp<2' mcp-obsidian` if that binary is missing. The fallback works but re-resolves an ad-hoc environment on *every* launch, which takes over a minute and makes startup race itself.
- **The `mcp<2` pin is load-bearing.** `mcp` 2.0.0 removed `Server.list_tools`, which `mcp-obsidian` 0.2.2 decorates at import time. An unpinned resolve kills the server on startup and every Obsidian tool — including the CRM — silently stops working. Symptom in `/tmp/glass-overlay.log`: `obsidian-mcp warm-up failed`. Don't drop the pin without checking `mcp-obsidian` supports mcp 2.x.
- **MCP warm-up retries.** The `app.whenReady()` warm-up retries 3× with backoff, because spawning the child during Electron startup can trip `EINTR` on the stdio read. It's only a warm-up — failure is non-fatal, since the client lazy-inits on first real use.
- **Window rescue.** After a day or so of uptime macOS has twice ordered the window out for good, and `show()` could not bring it back. `revealWindow()` (used by the shortcut and by relaunching Glass.app) re-applies the all-Spaces and floating flags, then 500 ms later asks `ekhelper window-onscreen <CGWindowID>`. If the window server says the window is not on screen, it destroys and recreates the window, losing the open conversation. Both outcomes are logged as `reveal:` lines in `/tmp/glass-overlay.log`.
- **Codesigned helper.** `ekhelper` must remain codesigned (`codesign --sign -`) or macOS will refuse to load it. The `build:helper` script does this; don't ship an unsigned binary.

## Models

Configured at the top of `renderer/app.js`:

- `MODEL_FAST = 'claude-haiku-4-5-20251001'` — default, used for short text-only turns.
- `MODEL_DEEP = 'claude-sonnet-4-6'` — used when input has an image, is long, looks like code, or matches debug/plan/research heuristics in `pickModel()`.
- User can force a model with a `/fast`, `/haiku`, `/deep`, or `/sonnet` prefix; `stripModelPrefix()` removes it before sending.

## Runtime memory (separate from .claude/memory)

The overlay app keeps its own long-term memory at `~/Library/Application Support/overlay/memory/` — a tree of markdown files (`memory.md` index, `general.md`, `domain/<topic>.md`, `tools/<tool>.md`). The renderer exposes five tools (`list_memory_files`, `read_memory`, `write_memory`, `append_memory`, `delete_memory`) backed by the `memory:*` IPC channels. Full spec: `overlay/MEMORY_SYSTEM.md`.

This is the **runtime overlay's memory** — the app's user-facing assistant uses it. It is unrelated to Claude Code's own auto-memory under `~/.claude/.../memory/`.

## People CRM

A contact graph in the user's Obsidian vault at `Career/People/` — one markdown note per person, with `knows:` frontmatter links as the graph edges. Its purpose is **intro path-finding**, not record-keeping.

Two IPC channels in `main.js` (`person:capture`, `person:list`) back the renderer tools `crm_capture` / `crm_list`, exposed as `window.people` in `preload.js`. They ride on the existing Obsidian MCP client via `callObsidianTool` rather than touching the filesystem, so there is **no new path surface** — the only validation needed is `personPath()`, which rejects `/`, `\` and `..` in a person's name.

- Frontmatter is deliberately five fields (`status`, `company`, `knows`, `last_contact`, `next_step`) plus `type: person`. Resist adding more; the first version had twelve and most stayed empty.
- `person:capture` merges rather than overwrites: supplied fields win, `knows` edges are unioned, and `note` becomes a dated bullet under `## Log`.
- Writing a note is delete-then-append (`overwriteNote`) because the Obsidian MCP surface has no replace verb. It retries once and throws with the full content attached so a note can't be silently lost between the two calls.
- `person:list` uses `cachedRead`; `person:capture` calls `cacheInvalidate('person:')`.
- The capture policy lives in `buildSystemPrompt()` under "People CRM — capture policy" — the key rule is that only *stated* relationships become edges, never ones inferred from a shared employer or event.

## Health log

A symptom diary at `Health/Health Log.md` in the Obsidian vault, append-only, one line per entry. Two IPC channels in `main.js` (`health:log`, `health:list`) back the renderer tools `health_log` / `health_history`, exposed as `window.health` in `preload.js`. Like the CRM they ride on `callObsidianTool` with a constant path, so there is no new path surface. The file header (written on first use) documents the line format and the body encoding, so the note is self-describing.

- **Capture policy** lives in `buildSystemPrompt()` under "Health — capture policy": silent and opportunistic, like the CRM. Any mention of the user's own health gets a `health_log`; physical pain gets `show_body_map` first.
- **Body map** (`show_body_map` → `showBodyMapCard` in `renderer/app.js`) renders front and back silhouettes side by side; the user shades cells with a brush at an intensity 1-10, with Paint / Erase / Clear and Save / Skip. The tool call blocks the agentic loop until Save or Skip (10-minute timeout; typing anything also skips it). Pre-shading comes from `suggest` via `bodyRegionLookup`. The shaded result is ground truth: the prompt forbids re-opening the map to "correct" it.
- **Encoding** (never an image): the 100×200 figure is a 20×40 grid of 5-unit cells, index `row*20+col`. A code is `<F|B><intensity>:<runs>` parts joined by `;`, e.g. `F7:612-614,632-634;B3:340-342`. `encodeBodyMap` / `decodeBodyMap` are the only codec; `main.js` validates with `BODY_CODE_RE`. `addHealthCard` redraws the shading from the code after every `health_log`, which is the recreatability check.
- Region names in the log come from `BODY_REGIONS` (nearest anchor per shaded cell, anatomical side derived from the view). Keep the figure geometry (`BODY_HALF`) and the anchors in step if you redraw the figure.
- `health:list` uses `cachedRead`; `health:log` calls `cacheInvalidate('health:')`.

## Lunch recommendations

`lunch:menu` in `main.js` (exposed as `window.lunch`) backs the `get_lunch_menu` tool for `pembroke` (scrapes the What's for Trough site, `?date=YYYY-MM-DD`) or `west_hub` (scrapes the University Catering page, which only publishes the current week). URLs are constants and the date is regex-checked. Both parsers throw on a layout change rather than returning an empty menu. Uses `cachedRead`.

The taste profile is a vault note, `Personal Life/Food Profile.md`: a `## Patterns` summary above an append-only `## Log`, which must stay last because `obsidian_append` appends. Patterns are rewritten with `obsidian_patch` on heading `Food Profile::Patterns`. The rules live in `buildSystemPrompt()` under "Lunch — policy": the venue comes from the calendar (Emily's lectures are on the West site, so midday teaching means `west_hub`), and if there is no 30-minute gap in serving hours the answer is to pack something. `pickModel()` routes food questions to `MODEL_DEEP`, because Haiku skipped the calendar reasoning. No card; the answer is one or two lines.

## Cards (rich widgets in the transcript)

Some tool results render as glass-styled cards instead of text. All card DOM is built with `createElement` in `renderer/app.js` (never `innerHTML` — tool output is untrusted) and styled by the `.card*`, `.wx-*` and `.map-*` rules at the bottom of `style.css`.

- **Weather card** — auto-rendered in `runAgenticLoop` whenever `get_weather` returns (`addWeatherCard`). The model is told to add at most one line afterwards. If Open-Meteo is down (timeout, 429, 5xx), `weather:get` returns `{ unavailable: true }` (not cached) instead of throwing, no card is drawn, and the tool description tells the model to leave weather out silently.
- **Map card** — rendered by the `show_map` tool (`showMapCard`): a centre marker, up to 8 numbered pins, and a ranked list with distance + walk minutes. Tiles come from OpenStreetMap via the `map:tiles` IPC channel, which fetches them in main and returns `data:` URLs so the renderer CSP (`img-src 'self' data:`) is untouched. Tiles are darkened with a CSS filter to sit inside the glass. Retina fetches one zoom level deeper and draws at half size.
- **Places data** — `find_places_nearby` → `places:nearby` (Overpass QL). `kind` is a whitelist (`PLACE_KINDS` in `main.js`) so nothing user-controlled reaches the query. `overpassQuery` tries the primary server twice then two mirrors, 12s each, because public Overpass 504s under load. `geocode` → `geo:geocode` (Nominatim). `fetchWeather` falls back to Nominatim when Open-Meteo's name-only geocoder misses (e.g. "Cambridge UK", street addresses).
- All three channels are read-shaped and use `cachedRead`; tiles additionally use a longer-lived `tileCache` (LRU-ish, 400 entries).
- **Music card** — rendered by `play_music` (`playMusicCard` → `spotify:play`), `now_playing`, and updated in place by `music_control` or the card's own Prev/Pause/Next buttons (which call `spotify:control` directly, no model round-trip). Album art is fetched in main and returned as a `data:` URL (`fetchSpotifyArt`, host-whitelisted to `*.scdn.co` / `*.spotifycdn.com`) for the same CSP reason as tiles. `stripArt()` drops the data URL before the result goes back to the model.
- **Spotify auth** — Web API with PKCE. `SPOTIFY_CLIENT_ID` in `.env`; the app must list `http://127.0.0.1:8899/callback` as a redirect URI. First use opens a popup `BrowserWindow` and a one-shot loopback `http` listener catches the code. Tokens rotate, so they live in `userData/spotify-tokens.json` (mode 600), not `.env`. If the Web API says no active device (404) or not Premium (403), playback falls back to the desktop app via AppleScript (`buildSpotifyPlay`, URI regex-validated and `escapeAS`'d). Searches use `cachedRead`; `spotify:now` deliberately does not.
- OSM tile and Nominatim usage policies require a real `User-Agent` (`GEO_UA`) and low volume — fine for a single-user app; do not add background prefetching.

Adding another card type: add a `.card-<kind>` block in `style.css`, a `add<Kind>Card(data)` builder next to `addWeatherCard`, and either hook it on a tool name in `runAgenticLoop` (auto-render) or expose it as a tool the model calls (like `show_map`).

## Voice mode (Deepgram)

`⌘⇧M` (global shortcut) toggles push-to-talk. The renderer captures the mic with `getUserMedia`, downsamples to 16 kHz Int16 PCM in a `ScriptProcessorNode`, and streams chunks over `voice:audio` (fire-and-forget `ipcRenderer.send`). `main.js` owns the Deepgram Nova WebSocket and the key (`DEEPGRAM_API_KEY`), forwards transcript events back with `webContents.send('voice:event')`, and the renderer writes them into the composer live. On Deepgram's `speech_final` / `UtteranceEnd` the renderer auto-submits and sets `voice.speakNext`, so `submit()` speaks the reply afterwards via `voice:speak` (Deepgram v2 speak, Flux voice, returned as a `data:audio/mpeg` URL; CSP has `media-src 'self' data:` for this). `speakable()` strips markdown before TTS. Escape stops listening or playback.

- Auth for the socket rides on the `['token', key]` subprotocol because Node's global `WebSocket` cannot set headers. Do not add the `ws` package for this.
- Mic permission goes through `systemPreferences.askForMediaAccess('microphone')` before the socket opens; the TCC prompt is attributed to Electron.
- `DEEPGRAM_VOICE` / `DEEPGRAM_SPEED` / `DEEPGRAM_EXPRESSIVITY` in `.env` override the voice (default `aura-2-athena-en`; speed and expressivity only apply to Flux voices). Flux ids go to the v2 endpoint, Aura ids to v1; `voice:speak` picks by prefix.
- Voice input is one utterance per press by design; continuous conversation mode is not built.

## Radio host (proactive interjections)

A timer in `renderer/app.js` (`radioTick`, every 20 min, first run 90 s after launch) runs a **side conversation** that never touches `conversation`: its own system prompt (`radioSystemPrompt`), Haiku, and a read-only tool subset (`RADIO_TOOLS`: calendar, reminders, weather, memory reads) through the same `streamMessage` / `runTool` path. The model returns `{"say": ..., "key": ...}` or `{"say": null}`. A `.card-radio` card is always shown; the line is **spoken only when Spotify is playing** (`spotify:now` with `quiet: true`, which never triggers the login popup), with the desktop app ducked via `spotify:volume` (AppleScript, works without Premium).

- **Morning briefing** is a mode of the same tick: the first automatic tick at or after `RADIO_BRIEFING_HOUR` (08:00) with no `briefing-<date>` key yet runs `radioSystemPrompt(said, test, briefing=true)` on `MODEL_DEEP`, returning `say` + `sections` (rendered by `addBriefingCard`) + optional `music`. The briefing alone also gets `get_unread_mail` (`BRIEFING_TOOLS`), triages the inbox into a "Mail" section of at most 4 items, and skips mail silently if Mail.app errors. Regular ticks never read mail. It also reads `domain/dissertation.md` from the runtime memory store and adds a "Dissertation" section (current work-plan block, next hard deadline, one task sized to the day's calendar); update that file, not the prompt, when the plan changes. `/briefing` (or `/radio briefing`) runs it on demand and is spoken even with no music, because the user asked.
- **Dedupe** is by model-chosen key in `localStorage` (`glass.radio.said`, 36 h window). Recurring items carry the date in the key (`briefing-2026-09-27`), so the daily briefing is not suppressed by yesterday's. Don't "fix" the dedupe by hashing the text.
- Guardrails: max 12/day, skipped while busy or in a voice session. No quiet hours by choice (Emily wants overnight nudges). Speech is synthesized *before* the card is added so the voice lands with it; the model may attach a `music` suggestion, rendered as a Play button (never auto-played). `/radio on|off|now|test|reset` in the composer; `now` forces a tick and ignores the said-list; `test` additionally tells the model to invent a heads-up (prefixed "Test:") if nothing real qualifies, and does not record it.
- `streamMessage` takes an optional `tools` array for this; default remains `TOOLS`.

## Alarm

`/alarm HH:MM [weekdays|once]` arms an alarm (`once` clears itself after firing; set for a past time it means tomorrow) in `localStorage` (`glass.alarm`); `/alarm test` runs the full sequence now with a short tone. Sequence in `alarmFire()`: `system:volume` (AppleScript, validated 0-100) → WebAudio two-tone ramp (`alarmTone`, no audio asset) with a Stop button / Escape → forced spoken briefing, prepared during the tone via `radioTick(..., { defer: true })` which returns a `deliver()` → `playMusicCard` with the wake-up query (`/alarm music <query>`, `off` to skip). `alarmCheck` polls every 20 s and fires once per day (`lastFired`); if the Mac was asleep at alarm time and wakes within 2 h it fires `late` (no tone, straight to briefing + music); on battery it skips and leaves a card saying so (`system:onBattery`).

- While armed, the renderer tells main via `alarm:armed`, and main holds a `powerSaveBlocker('prevent-app-suspension')` **only on mains power** (`powerMonitor`), so display sleep does not become system sleep. Lid-closed sleep still wins; Emily knows to leave the lid open or use `pmset repeat wakeorpoweron`.
- `window:show` uses `showInactive()` so the alarm never steals focus from whatever is on screen.

## Lab job watch

`overlay/scripts/job-watch.mjs` (`npm run jobs`, `-- --dry` to preview) scans the frontier labs and ~15 London-relevant neolabs listed in `BOARDS` (Greenhouse / Ashby / Lever JSON APIs) plus Google DeepMind (Google Careers HTML, London only) for London/UK roles. Trading firms (HRT, Jane Street, Jump, XTX, DRW, Squarepoint, IMC) are in `BOARDS` with an `'ai'` flag, so only titles matching `AI_TITLE` are kept. A keyword prefilter drops senior, non-technical and >2-years roles; `MODEL_DEEP` (Sonnet) then judges the rest against `scripts/job-profile.md` (gitignored; template in `job-profile.example.md`) as apply / stretch / skip. Results go to `Career/Lab Job Watch.md` in the Obsidian vault (overwritten each run), and new roles trigger a macOS notification. State and cached verdicts live in `~/Library/Application Support/overlay/job-watch.json`; delete it to re-judge everything. Runs Mondays 09:00 via `~/Library/LaunchAgents/com.emilykelt.glass.jobwatch.plist`, logging to `/tmp/glass-jobwatch.log`. Update `job-profile.md` when Emily's situation changes.

## Conventions

- No bundler in the renderer. New JS files load via `<script>` tags in `index.html`. ES module `<script type="module">` is fine if you need imports; CommonJS in the renderer is not.
- No tests, no linter, no formatter. Match the existing style: 2-space indent, single quotes, no semicolon-stripping, plain functions over classes.
- Don't add dependencies casually. Current runtime deps: `@modelcontextprotocol/sdk`, `dotenv`. Anything else needs a real reason.
- Don't narrate in the assistant UI. The system prompt instructs the model to be terse and never preamble; if you change the prompt, preserve that.

## Claude Code automation in this repo

- **Hook:** `Edit`/`Write` against `overlay/.env` is blocked (`.claude/settings.json`). The file holds live API keys; edit it manually.
- **Agents** (in `.claude/agents/`, invoke via the Agent tool):
  - `ipc-security-reviewer` — audits new IPC channels for path traversal, AppleScript injection, over-broad renderer surface. Run after touching `main.js` or `preload.js`.
  - `renderer-refactor-scout` — maps seams in the bloated `renderer/app.js` into a ranked, cheapest-first refactor plan.
  - `applescript-auditor` — audits `build*` AppleScript functions for `escapeAS` coverage, balanced `tell`/`end tell`, and `build*`/`parse*` field-count parity. Run after touching any AppleScript-building code.
  - `system-prompt-tuner` — audits `buildSystemPrompt()` in `renderer/app.js` for drift from `TOOLS[]`, redundancy, internal conflict, and dead rules. Run after editing the prompt or adding/removing a tool.
  - `overlay-memory-curator` — audits the runtime memory store at `~/Library/Application Support/overlay/memory/` for index drift, stale entries, duplication, and bloat. Run every few weeks.
