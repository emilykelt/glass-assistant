# Glass — floating Claude overlay

A frameless, always-on-top liquid-glass desktop window for talking to Claude. Built on Electron, with native Apple Calendar and Reminders tool use via AppleScript.

## Quickstart

```bash
cd overlay
npm install
cp .env.example .env   # then paste your key
npm start
```

The app will launch as a 380×560 floating window with macOS vibrancy. Press **⌘⇧Space** anywhere to toggle it.

## API key

Open `overlay/.env` and replace the placeholder:

```
ANTHROPIC_API_KEY=sk-ant-...
```

The key is loaded by `dotenv` in the main process and handed to the renderer through the `api.getApiKey` IPC channel — it never leaves your machine except in the request to `api.anthropic.com`.

## macOS permissions

Calendar and Reminders access are gated by the macOS TCC system. The first time the app calls one of the tools, macOS will prompt you to allow access for the binary running osascript (typically the Electron app itself, sometimes `osascript`).

If you miss the prompt — or want to grant access ahead of time — open:

- **System Settings → Privacy & Security → Calendars** — enable the Electron app.
- **System Settings → Privacy & Security → Reminders** — enable the Electron app.

The app shows a one-time onboarding modal with shortcuts to those panes.

## Keyboard shortcuts

| Shortcut          | Action                                |
| ----------------- | ------------------------------------- |
| `⌘⇧Space`         | Show / hide the overlay (global)      |
| `⌘K`              | Clear the current conversation        |
| `Enter`           | Send the message                      |
| `Shift+Enter`     | New line in the composer              |

## Tools available to Claude

The model is given five AppleScript-backed tools:

- `get_todays_events`
- `get_upcoming_events(days)`
- `create_event(title, startTime, endTime, calendarName)`
- `get_reminders`
- `create_reminder(title, dueDate?, listName)`

Claude may chain multiple tool calls in a single turn before producing a final answer; the renderer runs the full agentic loop and shows each tool invocation as a small pill in the transcript.

## File layout

```
overlay/
  main.js            BrowserWindow, global shortcut, IPC, AppleScript runner
  preload.js         contextBridge: window.appleScripts, window.api
  renderer/
    index.html       layout
    style.css        liquid-glass styles
    app.js           streaming + tool-use loop + conversation state
  .env               ANTHROPIC_API_KEY
  package.json
```

## Notes

- The window is set with `vibrancy: 'under-window'` and `setAlwaysOnTop(true, 'floating')` so it floats above fullscreen apps.
- Streaming uses the Anthropic Messages API directly via `fetch` with `anthropic-dangerous-direct-browser-access: true`. For production use, proxy through your own backend.
- Update `MODEL` at the top of `renderer/app.js` to switch Claude versions.
