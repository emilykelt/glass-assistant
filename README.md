# Glass

A frameless, always-on-top liquid-glass window for talking to Claude on macOS. It calls the Anthropic Messages API directly and gives the model tools for your Mac: Calendar, Reminders, Mail, Spotify, Obsidian, Anki, weather, maps and screenshots. It also keeps its own long-term memory.

Built for one person on one Mac. There are no tests and no CI.

## Features

- **Chat overlay.** Press `⌘⇧Space` anywhere to show or hide it. It streams replies and runs a full tool-use loop. Short turns go to Haiku. Turns with images, code, long input or planning go to Sonnet. Prefix a message with `/fast` or `/deep` to pick the model yourself.
- **Native tools.** Calendar and Reminders run through a small Swift EventKit helper (`ekhelper`), and Mail runs through AppleScript.
- **Cards.** Some results show as glass widgets in the transcript instead of text: weather, maps with numbered pins (OpenStreetMap), Spotify now-playing with playback controls, morning briefings, and a body map for the health log.
- **Voice.** `⌘⇧M` is push-to-talk. Deepgram does speech-to-text and text-to-speech.
- **Radio host.** Every 20 minutes a side conversation checks your calendar, reminders and weather. If something is worth saying, it shows a card, and speaks the line if music is playing. The first tick after 08:00 gives a morning briefing.
- **Alarm.** `/alarm 07:30 weekdays` plays a tone, then a spoken briefing, then music.
- **Memory.** Markdown files in `~/Library/Application Support/overlay/memory/`, which the model reads and writes through tools. See [`overlay/MEMORY_SYSTEM.md`](overlay/MEMORY_SYSTEM.md).
- **Obsidian.** A vault bridge via [`mcp-obsidian`](https://github.com/MarkusPfundstein/mcp-obsidian). A people CRM, a health log and a food profile are built on top of it.
- **Anki.** Creates flashcards through AnkiConnect.
- **Telegram agent** (`npm run agent`). A headless process that answers calendar and reminders questions over Telegram, with no Electron.
- **Job watch** (`npm run jobs`). A weekly scan of AI lab job boards. Sonnet judges each role against a profile you write.

## Setup

Requires macOS, Node 20+, and the Xcode command-line tools (to build `swiftc`).

```bash
cd overlay
npm install                 # also builds and codesigns ekhelper
cp .env.example .env        # then fill in your keys
npm start
```

Only `ANTHROPIC_API_KEY` is required. Each other key in `.env.example` turns on one feature:

| Key | Feature |
| --- | --- |
| `OBSIDIAN_API_KEY` | Obsidian vault tools (needs the Local REST API plugin) |
| `SPOTIFY_CLIENT_ID` | Music cards (add `http://127.0.0.1:8899/callback` as a redirect URI) |
| `DEEPGRAM_API_KEY` | Voice mode and spoken radio lines |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_IDS` | Telegram agent |

Install the Obsidian MCP server once. The `mcp<2` pin is required: `mcp` 2.x breaks `mcp-obsidian` 0.2.2.

```bash
uv tool install mcp-obsidian --with 'mcp<2'
```

For job watch, copy `overlay/scripts/job-profile.example.md` to `job-profile.md` and describe yourself. That file is gitignored.

### macOS permissions

The first time Glass uses Calendar, Reminders, Mail, the microphone or screen capture, macOS asks for permission. If you miss a prompt, go to **System Settings → Privacy & Security** and allow the app there.

Launch Glass from `overlay/Glass.app` rather than a terminal. If you start it from a shell, macOS can attribute the permission to the terminal instead, and Calendar access is denied.

## Shortcuts

| Shortcut | Action |
| --- | --- |
| `⌘⇧Space` | Show or hide the overlay |
| `⌘⇧M` | Push-to-talk |
| `⌘⇧I` | Attach a screenshot |
| `⌘K` | Clear the conversation |
| `Esc` | Stop listening or playback |

Composer commands: `/fast`, `/deep`, `/briefing`, `/radio on|off|now|test`, `/alarm HH:MM [weekdays|once]`.

## Layout

```
overlay/
  main.js           Electron main process: window, shortcuts, every IPC handler,
                    AppleScript builders, Spotify, Deepgram, Obsidian MCP client
  preload.js        contextBridge surface exposed to the renderer
  renderer/         index.html, style.css, app.js (prompt, tools, agentic loop, cards)
  ekhelper.swift    EventKit helper for Calendar and Reminders
  agent/            Headless Telegram agent
  scripts/          job-watch.mjs, log-idea.mjs
IDEAS.md            Feature backlog
CLAUDE.md           Architecture notes and invariants
```

## Security notes

- The renderer is sandboxed (`contextIsolation: true`, no `nodeIntegration`). Every privileged call goes through a named IPC channel in `preload.js`.
- User text in AppleScript always goes through `escapeAS()`. Memory file paths always go through `resolveMemPath()`, which keeps them inside the memory folder.
- The API key is sent to the renderer, and requests go straight from the renderer to `api.anthropic.com`. That is fine for a personal app on your own machine, but don't ship it to anyone else this way.

[`CLAUDE.md`](CLAUDE.md) has the full architecture notes.
