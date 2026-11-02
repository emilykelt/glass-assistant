# Ideas — Glass feature backlog

Features and changes we're considering, newest at the bottom. Each entry is stamped
with the date it was logged and the commit HEAD at that moment.

**Why the commit stamp:** it anchors the idea in time. Before acting on an old idea,
run `git log <sha>..HEAD --oneline` (using the entry's SHA) to see what has changed
since — an idea logged 40 commits ago may already be done or no longer make sense.

Add entries with `npm run idea -- "Title" "Description"` (auto-stamps date + commit).
Set `Status:` to `open` / `in progress` / `done` / `dropped` by hand.

---

### Embedding-based memory retrieval (only if the store outgrows context)
- Logged: 2026-07-27 (Monday) at `8ced199` — add security review agents
- Status: open

Deferred from the graph-memory work: if the runtime memory store ever grows past what fits in the system prompt / whole-file reads (thousands of notes), add embedding + vector retrieval on top of the existing wikilink graph. Not worth the infra/latency below that threshold. Revisit when memory:tree shows the store is large.

---

### D3 graph interface for the Obsidian People CRM
- Logged: 2026-07-27 (Monday) at `8ced199` — add security review agents
- Status: open

Interactive HTML/D3 force-directed view of Career/People/ in the Obsidian vault: nodes = person notes, edges = frontmatter 'knows' links, node size/colour by closeness + status. Wants shortest-path queries ('how do I reach Anthropic') and filtering by tag/status. Data source is markdown frontmatter, read via the Obsidian MCP client already wired up in main.js. Could render in a Glass panel or as a standalone HTML artifact.

---

### Host the texting agent off-Mac (Raspberry Pi)
- Logged: 2026-09-20 (Sunday) at `d8dbf79` — Add IDEAS.md feature backlog with date + commit stamps
- Status: open

Move overlay/agent/ off the Mac onto a Raspberry Pi at home so it stays up. The whole Mac dependency is one function: ek(args) in agent/ek.js:10 (argv in, JSON out) - index.js/loop.js/telegram.js are pure Node, no Electron. Telegram long-polls outbound so the Pi needs no public port. OPEN DECISION (paused): how calendar/reminders work off-Mac, since ekhelper is a codesigned macOS binary and cannot run on ARM Linux. Options were (a) iCloud CalDAV via app-specific password + tsdav, ~5h, Mac-independent, Reminders as VTODOs; (b) Mac relay over WSS running ekhelper, ~3h, dies when the Mac sleeps; (c) migrate to Google Calendar. Also unresolved: Obsidian vault is in iCloud Drive, so Pi access needs git sync. Chat + memory alone would run on the Pi today.

---

### Mood-based music
- Logged: 2026-09-26 (Saturday) at `d8dbf79` — Add IDEAS.md feature backlog with date + commit stamps
- Status: in progress (card + Spotify Web API built 2026-09-26; needs SPOTIFY_CLIENT_ID + first login to verify)

Pick and play music matching the mood/topic of the current conversation. Likely Spotify (AppleScript 'tell application "Spotify" to play track' or Web API) or Apple Music via AppleScript. Model emits a mood/genre tag as a tool call; main.js maps to a playlist or search.

Spotify Web API is also an option (OAuth PKCE, Search + Recommendations endpoints with target_valence/energy, Player API to start playback on the current device). Gives real mood search rather than a fixed playlist map, at the cost of a one-time OAuth flow and token refresh in main.js. Decision (2026-09-26): not a fixed playlist map. Model composes a free-text mood/genre query, main.js hits Spotify Search (tracks + playlists), then starts playback. AppleScript kept only as a fallback for play/pause/skip when the Web API device is not active.

---

### Voice mode
- Logged: 2026-09-26 (Saturday) at `d8dbf79` — Add IDEAS.md feature backlog with date + commit stamps
- Status: in progress (built 2026-09-26 on Deepgram; TTS + STT auth verified from node, mic path needs a real-use test)

Talk to the overlay by voice. STT via Web Speech API in renderer or whisper; TTS via ElevenLabs (credits available) streamed through an audio element. Push-to-talk on the global shortcut, reply spoken + shown in transcript.

Vapi note (2026-09-26): Emily has YC student credits ($100 on applying). Vapi is a full voice-agent stack (STT + turn-taking + LLM + TTS), not an a-la-carte TTS/STT API. To keep Glass's own tool loop it would need the `custom-llm` provider pointing at an OpenAI-compatible endpoint reachable from Vapi's cloud, i.e. a tunnel to main.js. Fragile for a local overlay. Better use: a phone-number voice agent on top of overlay/agent/ (the Telegram/Pi agent), which already runs as a plain Node server. For in-overlay voice, ElevenLabs TTS + local STT stays the plan.

Deepgram decision (2026-09-26): Emily has $15k YC student credits. Deepgram is a plain STT + TTS API (Nova-3 streaming STT over WebSocket, Aura-2 TTS over REST), so it slots straight into Glass's existing loop with no cloud agent in the middle. Use it for both directions: renderer captures mic (getUserMedia) and streams PCM to main.js, main.js holds the Deepgram WebSocket and the API key, transcript goes into the composer, reply text goes to Aura-2 and plays back as a data: URL audio element. ElevenLabs becomes an optional TTS swap if Aura voices are not nice enough. Vapi dropped for the overlay.

---

### Radio host: proactive spoken interjections
- Logged: 2026-09-26 (Saturday) at `d8dbf79` — Add IDEAS.md feature backlog with date + commit stamps
- Status: in progress (built 2026-09-26; card always, speech only over music, dedupe by dated key)

Occasionally, and only when there is something new to say, Glass speaks up unprompted like a radio host between songs: looks ahead at calendar + reminders + weather and says one useful line (e.g. rain later and you leave the house at 2 -> take an umbrella; supervision in 40 min; reminder due). Design: a main.js timer (every ~20 min, only while awake and not mid-conversation) gathers today's events, reminders, weather into a compact brief; a cheap Haiku call with a strict 'say nothing unless useful' contract and a list of what has already been said (dedupe store, memory file) returns either NOTHING or one sentence; if music is playing, duck Spotify volume, speak via Deepgram, restore. Guardrails: max N interjections/day, quiet hours, never during a voice session, per-fact dedupe by hash, off switch in shortcuts popover. Stretch: tie to Spotify track boundaries so it lands between songs.

---

### Dedicated email inbox for Glass
- Logged: 2026-09-26 (Saturday) at `d8dbf79` — Add IDEAS.md feature backlog with date + commit stamps
- Status: open

Give Glass its own address (Fastmail or a Gmail with an app password). Reads over IMAP (imapflow, one dep) and sends over SMTP, so it works off-Mac for the Pi/Telegram agent where Mail.app AppleScript is unavailable. Uses: forward Glass anything (tickets, itineraries, PDFs) and it files/extracts into memory or Obsidian; receive calendar invites as .ics and add them; a 'digest' the radio host can read. Keep the existing Mail.app tools for the overlay; this is the agent's inbox, not Emily's. Pairs with the iCloud CalDAV option that unblocks calendar/reminders off-Mac.

---

### Alarm -> morning briefing -> wake-up playlist
- Logged: 2026-09-26 (Saturday) at `d8dbf79` — Add IDEAS.md feature backlog with date + commit stamps
- Status: in progress (built 2026-09-26; /alarm test; sleep blocker on AC)

/alarm 07:30 sets a daily alarm in localStorage. At the time: (1) raise system output volume via AppleScript (static, validated int), play a synthesized WebAudio alarm tone that ramps up, with a Stop button + Escape; (2) once stopped (or after 60s) run the briefing in forced mode so it is spoken regardless of music; (3) then play_music with a wake-up query (configurable, default 'wake up morning energy'). Blocker: the Mac must be awake — schedule with 'sudo pmset repeat wakeorpoweron MTWRFSU 07:29:00' (one-time), or keep it plugged in with a powerSaveBlocker while an alarm is armed. Skip weekends via /alarm 07:30 weekdays.

---
