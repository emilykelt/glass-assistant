const { app, BrowserWindow, globalShortcut, ipcMain, shell, desktopCapturer, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const util = require('util');
const execFileP = util.promisify(execFile);
require('dotenv').config({ path: path.join(__dirname, '.env') });

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 380,
    height: 560,
    minWidth: 220,
    minHeight: 200,
    frame: false,
    transparent: true,
    resizable: true,
    hasShadow: true,
    alwaysOnTop: true,
    vibrancy: 'hud',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    skipTaskbar: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.on('resize', () => {
    if (!win || win.isDestroyed()) return;
    const [, h] = win.getSize();
    if (lastProgrammaticHeight !== null && h !== lastProgrammaticHeight) {
      win.webContents.send('manual-resize');
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

let lastProgrammaticHeight = null;

function toggleWindow() {
  if (!win) return;
  if (win.isVisible() && win.isFocused()) {
    win.hide();
  } else {
    win.show();
    win.focus();
  }
}

app.whenReady().then(() => {
  createWindow();

  const ok = globalShortcut.register('CommandOrControl+Shift+Space', toggleWindow);
  if (!ok) console.warn('Failed to register global shortcut Cmd+Shift+Space');

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

const HELPER_BINARY = path.join(__dirname, 'ekhelper');
const CACHE_TTL_MS = 60 * 1000;
const memCache = new Map();

function cacheGet(key) {
  const e = memCache.get(key);
  if (!e) return null;
  if (Date.now() - e.t > CACHE_TTL_MS) {
    memCache.delete(key);
    return null;
  }
  return e.v;
}
function cacheSet(key, v) {
  memCache.set(key, { v, t: Date.now() });
}
function cacheInvalidate(prefix) {
  for (const k of Array.from(memCache.keys())) {
    if (k.startsWith(prefix)) memCache.delete(k);
  }
}
async function cachedRead(key, fn) {
  const cached = cacheGet(key);
  if (cached !== null) return cached;
  const v = await fn();
  cacheSet(key, v);
  return v;
}

function hasHelper() {
  try {
    fs.accessSync(HELPER_BINARY, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function ekHelper(args) {
  const { stdout } = await execFileP(HELPER_BINARY, args, { maxBuffer: 10 * 1024 * 1024 });
  if (!stdout.trim()) return null;
  return JSON.parse(stdout);
}

function runAppleScript(script) {
  return new Promise((resolve, reject) => {
    const proc = spawn('osascript', ['-']);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr.trim() || `osascript exited ${code}`));
      else resolve(stdout);
    });
    proc.stdin.write(script);
    proc.stdin.end();
  });
}

ipcMain.handle('run-applescript', async (_e, script) => {
  return runAppleScript(script);
});

ipcMain.handle('get-api-key', () => process.env.ANTHROPIC_API_KEY || '');

const memoryDir = () => path.join(app.getPath('userData'), 'memory');

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function resolveMemPath(rel) {
  if (!rel || typeof rel !== 'string') throw new Error('path required');
  const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (clean.includes('..')) throw new Error('path traversal not allowed');
  if (!clean.endsWith('.md')) throw new Error('only .md files allowed');
  const base = path.resolve(memoryDir());
  const abs = path.resolve(base, clean);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error('path outside memory dir');
  }
  return abs;
}

function ensureMemoryBootstrap() {
  fs.mkdirSync(memoryDir(), { recursive: true });
  const indexPath = path.join(memoryDir(), 'memory.md');
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(
      indexPath,
      `# Memory Index

_Updated: ${todayISO()}_

Curated index of what is stored. Each file is a markdown document. Use \`read_memory\` to load a specific file only when its description matches the user's question.

## Files

- \`general.md\` — user preferences, identity, and environment.
`
    );
  }
  const generalPath = path.join(memoryDir(), 'general.md');
  if (!fs.existsSync(generalPath)) {
    fs.writeFileSync(
      generalPath,
      `# General

Stable preferences, identity, and environment for the user.

`
    );
  }
}

function migrateLegacyMemory() {
  const jsonPath = path.join(app.getPath('userData'), 'memory.json');
  if (!fs.existsSync(jsonPath)) return;
  try {
    const arr = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    if (Array.isArray(arr) && arr.length) {
      const today = todayISO();
      const block = arr
        .map((e) => {
          const d = (e.updated_at || today).slice(0, 10);
          return `- **[${d}]** ${e.content}`;
        })
        .join('\n');
      const generalPath = path.join(memoryDir(), 'general.md');
      fs.mkdirSync(memoryDir(), { recursive: true });
      const prefix = fs.existsSync(generalPath)
        ? fs.readFileSync(generalPath, 'utf8').replace(/\s+$/, '') + '\n\n'
        : `# General\n\nStable preferences, identity, and environment for the user.\n\n`;
      fs.writeFileSync(generalPath, prefix + '## Migrated entries\n\n' + block + '\n');
    }
    fs.renameSync(jsonPath, jsonPath + '.bak');
  } catch (err) {
    console.error('memory migration failed', err);
  }
}

function walkMemoryTree(rel = '') {
  const dir = path.join(memoryDir(), rel);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const sub = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...walkMemoryTree(sub));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const stat = fs.statSync(path.join(dir, entry.name));
      out.push({
        path: sub,
        size: stat.size,
        modified: stat.mtime.toISOString().slice(0, 10),
      });
    }
  }
  return out;
}

migrateLegacyMemory();
ensureMemoryBootstrap();

ipcMain.handle('memory:tree', () => walkMemoryTree());

ipcMain.handle('memory:read', (_e, rel) => {
  const abs = resolveMemPath(rel);
  if (!fs.existsSync(abs)) throw new Error(`memory file not found: ${rel}`);
  return fs.readFileSync(abs, 'utf8');
});

ipcMain.handle('memory:write', (_e, payload) => {
  const { path: rel, content } = payload || {};
  const abs = resolveMemPath(rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, String(content ?? ''));
  return { path: rel, bytes: Buffer.byteLength(String(content ?? '')) };
});

ipcMain.handle('memory:append', (_e, payload) => {
  const { path: rel, content } = payload || {};
  const abs = resolveMemPath(rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const existing = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  const trimmed = existing.replace(/\s+$/, '');
  const sep = trimmed ? '\n\n' : '';
  const next = trimmed + sep + String(content ?? '').replace(/\s+$/, '') + '\n';
  fs.writeFileSync(abs, next);
  return { path: rel, bytes: Buffer.byteLength(next) };
});

ipcMain.handle('memory:delete', (_e, rel) => {
  const abs = resolveMemPath(rel);
  if (!fs.existsSync(abs)) return { removed: false };
  fs.unlinkSync(abs);
  return { removed: true };
});

ipcMain.on('resize-to-content', (_e, height) => {
  if (!win || win.isDestroyed()) return;
  const [w] = win.getSize();
  const clamped = Math.max(120, Math.min(720, Math.round(height)));
  lastProgrammaticHeight = clamped;
  win.setSize(w, clamped, false);
});

ipcMain.on('set-window-size', (_e, payload) => {
  if (!win || win.isDestroyed()) return;
  const { width, height } = payload || {};
  if (typeof width !== 'number' || typeof height !== 'number') return;
  const w = Math.round(width);
  const h = Math.round(height);
  if (w < 220 || h < 200) {
    win.setMinimumSize(40, 40);
  } else {
    win.setMinimumSize(220, 200);
  }
  lastProgrammaticHeight = h;
  win.setSize(w, h, false);
});

ipcMain.handle('open-privacy', (_e, kind) => {
  const urls = {
    calendars: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars',
    reminders: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders',
    screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  };
  return shell.openExternal(urls[kind] || urls.calendars);
});

ipcMain.handle('capture-screen', async () => {
  if (!win || win.isDestroyed()) return null;
  const wasVisible = win.isVisible();
  if (wasVisible) win.hide();
  await new Promise((r) => setTimeout(r, 220));
  try {
    const display = screen.getPrimaryDisplay();
    const { width, height } = display.size;
    const scale = Math.min(1600 / width, 1);
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(width * scale),
        height: Math.round(height * scale),
      },
    });
    if (!sources.length) return null;
    const primary = sources.find((s) => s.display_id === String(display.id)) || sources[0];
    const png = primary.thumbnail.toPNG();
    return 'data:image/png;base64,' + png.toString('base64');
  } catch (err) {
    console.error('capture-screen failed', err);
    return null;
  } finally {
    if (wasVisible && win && !win.isDestroyed()) {
      win.show();
      win.focus();
    }
  }
});

const FIELD_SEP = '';
const RECORD_SEP = '';

const escapeAS = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');

function isoToASDateLines(iso, varName) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) throw new Error(`Invalid date: ${iso}`);
  return [
    `set ${varName} to current date`,
    `set year of ${varName} to ${d.getFullYear()}`,
    `set month of ${varName} to ${d.getMonth() + 1}`,
    `set day of ${varName} to ${d.getDate()}`,
    `set hours of ${varName} to ${d.getHours()}`,
    `set minutes of ${varName} to ${d.getMinutes()}`,
    `set seconds of ${varName} to ${d.getSeconds()}`,
  ].join('\n');
}

function buildGetTodaysEvents() {
  return `set fs to "${FIELD_SEP}"
set rs to "${RECORD_SEP}"
set output to ""
tell application "Calendar"
  set startOfDay to current date
  set hours of startOfDay to 0
  set minutes of startOfDay to 0
  set seconds of startOfDay to 0
  set endOfDay to startOfDay + (1 * days)
  repeat with cal in calendars
    try
      set calName to name of cal
      set evs to (every event of cal whose start date ≥ startOfDay and start date < endOfDay)
      repeat with ev in evs
        set evTitle to summary of ev
        set evStart to (start date of ev) as «class isot» as string
        set evEnd to (end date of ev) as «class isot» as string
        set output to output & evTitle & fs & evStart & fs & evEnd & fs & calName & rs
      end repeat
    end try
  end repeat
end tell
return output`;
}

function buildGetUpcomingEvents(days) {
  const n = Math.max(1, parseInt(days, 10) || 7);
  return `set fs to "${FIELD_SEP}"
set rs to "${RECORD_SEP}"
set output to ""
tell application "Calendar"
  set startOfDay to current date
  set hours of startOfDay to 0
  set minutes of startOfDay to 0
  set seconds of startOfDay to 0
  set endRange to startOfDay + (${n} * days)
  repeat with cal in calendars
    try
      set calName to name of cal
      set evs to (every event of cal whose start date ≥ startOfDay and start date < endRange)
      repeat with ev in evs
        set evTitle to summary of ev
        set evStart to (start date of ev) as «class isot» as string
        set evEnd to (end date of ev) as «class isot» as string
        set output to output & evTitle & fs & evStart & fs & evEnd & fs & calName & rs
      end repeat
    end try
  end repeat
end tell
return output`;
}

function buildCreateEvent({ title, startTime, endTime, calendarName }) {
  if (!title || !startTime || !endTime || !calendarName) {
    throw new Error('create_event requires title, startTime, endTime, calendarName');
  }
  return `${isoToASDateLines(startTime, 'startD')}
${isoToASDateLines(endTime, 'endD')}
tell application "Calendar"
  tell calendar "${escapeAS(calendarName)}"
    make new event with properties {summary:"${escapeAS(title)}", start date:startD, end date:endD}
  end tell
end tell
return "ok"`;
}

function buildGetReminders() {
  return `set fs to "${FIELD_SEP}"
set rs to "${RECORD_SEP}"
set output to ""
tell application "Reminders"
  repeat with lst in lists
    set listName to name of lst
    try
      set rems to (every reminder of lst whose completed is false)
      repeat with r in rems
        set rTitle to name of r
        set rDue to ""
        try
          set rDue to ((due date of r) as «class isot») as string
        end try
        set output to output & rTitle & fs & rDue & fs & listName & rs
      end repeat
    end try
  end repeat
end tell
return output`;
}

function buildCreateReminder({ title, dueDate, listName }) {
  if (!title || !listName) throw new Error('create_reminder requires title and listName');
  let props = `{name:"${escapeAS(title)}"`;
  let dueLines = '';
  if (dueDate) {
    dueLines = isoToASDateLines(dueDate, 'dueD') + '\n';
    props += `, due date:dueD`;
  }
  props += '}';
  return `${dueLines}tell application "Reminders"
  tell list "${escapeAS(listName)}"
    make new reminder with properties ${props}
  end tell
end tell
return "ok"`;
}

function parseEvents(stdout) {
  return stdout
    .split(RECORD_SEP)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [title, startTime, endTime, calendar] = r.split(FIELD_SEP);
      return { title, startTime, endTime, calendar };
    });
}

function parseReminders(stdout) {
  return stdout
    .split(RECORD_SEP)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [title, dueDate, list] = r.split(FIELD_SEP);
      return { title, dueDate: dueDate || null, list };
    });
}

ipcMain.handle('apple:get_todays_events', async () => {
  return cachedRead('events:today', async () => {
    if (hasHelper()) return await ekHelper(['today']);
    const out = await runAppleScript(buildGetTodaysEvents());
    return parseEvents(out);
  });
});

ipcMain.handle('apple:get_upcoming_events', async (_e, days) => {
  const n = Math.max(1, parseInt(days, 10) || 7);
  return cachedRead(`events:upcoming:${n}`, async () => {
    if (hasHelper()) return await ekHelper(['upcoming', String(n)]);
    const out = await runAppleScript(buildGetUpcomingEvents(n));
    return parseEvents(out);
  });
});

ipcMain.handle('apple:create_event', async (_e, args) => {
  if (hasHelper()) {
    await ekHelper(['create-event', args.title, args.startTime, args.endTime, args.calendarName]);
  } else {
    await runAppleScript(buildCreateEvent(args));
  }
  cacheInvalidate('events:');
  return { ok: true };
});

ipcMain.handle('apple:get_reminders', async () => {
  return cachedRead('reminders', async () => {
    if (hasHelper()) return await ekHelper(['reminders']);
    const out = await runAppleScript(buildGetReminders());
    return parseReminders(out);
  });
});

ipcMain.handle('apple:create_reminder', async (_e, args) => {
  if (hasHelper()) {
    await ekHelper(['create-reminder', args.title, args.dueDate || '', args.listName]);
  } else {
    await runAppleScript(buildCreateReminder(args));
  }
  cacheInvalidate('reminders');
  return { ok: true };
});

// --- Mail (AppleScript) ---------------------------------------------------

function buildGetUnreadMail(limit) {
  const n = Math.max(1, Math.min(parseInt(limit, 10) || 10, 50));
  return `set fs to "${FIELD_SEP}"
set rs to "${RECORD_SEP}"
set output to ""
set theLimit to ${n}
set i to 0
tell application "Mail"
  set unreadMsgs to (messages of inbox whose read status is false)
  repeat with msg in unreadMsgs
    if i ≥ theLimit then exit repeat
    try
      set s to subject of msg
      set sndr to sender of msg
      set dt to ((date received of msg) as «class isot») as string
      set mid to ""
      try
        set mid to message id of msg
      end try
      set snippet to ""
      try
        set rawCnt to content of msg as string
        if (count of rawCnt) > 240 then
          set snippet to text 1 thru 240 of rawCnt
        else
          set snippet to rawCnt
        end if
      end try
      set output to output & s & fs & sndr & fs & dt & fs & mid & fs & snippet & rs
      set i to i + 1
    end try
  end repeat
end tell
return output`;
}

function buildSearchMail(query, limit) {
  const n = Math.max(1, Math.min(parseInt(limit, 10) || 10, 50));
  return `set fs to "${FIELD_SEP}"
set rs to "${RECORD_SEP}"
set output to ""
set theQuery to "${escapeAS(query)}"
set theLimit to ${n}
set i to 0
tell application "Mail"
  set matches to (messages of inbox whose (subject contains theQuery) or (sender contains theQuery))
  repeat with msg in matches
    if i ≥ theLimit then exit repeat
    try
      set s to subject of msg
      set sndr to sender of msg
      set dt to ((date received of msg) as «class isot») as string
      set output to output & s & fs & sndr & fs & dt & rs
      set i to i + 1
    end try
  end repeat
end tell
return output`;
}

function buildMarkMailRead(messageId) {
  return `tell application "Mail"
  set msgs to (messages of inbox whose message id is "${escapeAS(messageId)}")
  set n to count of msgs
  if n = 0 then
    return "0"
  end if
  repeat with msg in msgs
    set read status of msg to true
  end repeat
  return (n as string)
end tell`;
}

function buildCreateMailDraft({ to, subject, body }) {
  if (!to || !subject) throw new Error('create_mail_draft requires to and subject');
  const recipients = Array.isArray(to) ? to : String(to).split(/[,;]\s*/).filter(Boolean);
  const recipientLines = recipients
    .map((addr) => `    make new to recipient at end of to recipients with properties {address:"${escapeAS(addr)}"}`)
    .join('\n');
  return `tell application "Mail"
  set newMsg to make new outgoing message with properties {subject:"${escapeAS(subject)}", content:"${escapeAS(body || '')}", visible:true}
  tell newMsg
${recipientLines}
  end tell
  activate
end tell
return "ok"`;
}

function parseMail(stdout) {
  return stdout
    .split(RECORD_SEP)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [subject, sender, dateReceived, messageId, snippet] = r.split(FIELD_SEP);
      return {
        subject,
        sender,
        dateReceived,
        messageId: messageId || '',
        snippet: (snippet || '').replace(/\s+/g, ' ').trim().slice(0, 240),
      };
    });
}

function parseMailSearch(stdout) {
  return stdout
    .split(RECORD_SEP)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [subject, sender, dateReceived] = r.split(FIELD_SEP);
      return { subject, sender, dateReceived };
    });
}

ipcMain.handle('mail:get_unread', async (_e, limit) => {
  return cachedRead(`mail:unread:${parseInt(limit, 10) || 10}`, async () => {
    const out = await runAppleScript(buildGetUnreadMail(limit));
    return parseMail(out);
  });
});

ipcMain.handle('mail:search', async (_e, args) => {
  const { query, limit } = args || {};
  if (!query) throw new Error('search_mail requires query');
  const out = await runAppleScript(buildSearchMail(query, limit));
  return parseMailSearch(out);
});

ipcMain.handle('mail:create_draft', async (_e, args) => {
  await runAppleScript(buildCreateMailDraft(args || {}));
  return { ok: true };
});

ipcMain.handle('mail:mark_read', async (_e, args) => {
  const { messageId } = args || {};
  if (!messageId || typeof messageId !== 'string') {
    throw new Error('mark_mail_read requires messageId');
  }
  const out = await runAppleScript(buildMarkMailRead(messageId));
  const matched = parseInt(String(out).trim(), 10) || 0;
  cacheInvalidate('mail:');
  return { matched };
});

// --- Anki (via AnkiConnect on localhost:8765) -----------------------------

const ANKI_URL = 'http://127.0.0.1:8765';

async function ankiInvoke(action, params = {}) {
  let resp;
  try {
    resp = await fetch(ANKI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, version: 6, params }),
    });
  } catch (err) {
    throw new Error(
      `AnkiConnect unreachable — open Anki and install the AnkiConnect add-on (code 2055492159). (${err.message || err})`
    );
  }
  if (!resp.ok) throw new Error(`AnkiConnect HTTP ${resp.status}`);
  const data = await resp.json();
  if (data.error) throw new Error(`AnkiConnect: ${data.error}`);
  return data.result;
}

ipcMain.handle('anki:list_decks', async () => {
  return await ankiInvoke('deckNames');
});

ipcMain.handle('anki:add_card', async (_e, args) => {
  const { deck, front, back, tags } = args || {};
  if (!deck || !front || !back) throw new Error('anki_add_card requires deck, front, back');
  const id = await ankiInvoke('addNote', {
    note: {
      deckName: deck,
      modelName: 'Basic',
      fields: { Front: String(front), Back: String(back) },
      tags: Array.isArray(tags) ? tags : [],
      options: { allowDuplicate: false },
    },
  });
  return { id };
});

ipcMain.handle('anki:search_cards', async (_e, args) => {
  const { query, limit } = args || {};
  if (!query) throw new Error('anki_search_cards requires query');
  const noteIds = await ankiInvoke('findNotes', { query });
  if (!noteIds.length) return [];
  const slice = noteIds.slice(0, Math.max(1, Math.min(parseInt(limit, 10) || 25, 100)));
  const info = await ankiInvoke('notesInfo', { notes: slice });
  return info.map((n) => ({
    id: n.noteId,
    model: n.modelName,
    fields: Object.fromEntries(
      Object.entries(n.fields || {}).map(([k, v]) => [k, (v && v.value) || ''])
    ),
    tags: n.tags || [],
  }));
});

// --- Weather (Open-Meteo, no API key) -------------------------------------

async function fetchWeather(location) {
  const q = String(location || '').trim();
  if (!q) throw new Error('location required');
  const geoUrl =
    'https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=' +
    encodeURIComponent(q);
  const geoResp = await fetch(geoUrl);
  if (!geoResp.ok) throw new Error(`geocoding HTTP ${geoResp.status}`);
  const geo = await geoResp.json();
  if (!geo.results || !geo.results.length) {
    throw new Error(`no location found for "${q}"`);
  }
  const place = geo.results[0];
  const { latitude, longitude, name, country_code, admin1, timezone } = place;
  const fcUrl =
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,precipitation` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum` +
    `&forecast_days=3&timezone=${encodeURIComponent(timezone || 'auto')}`;
  const fcResp = await fetch(fcUrl);
  if (!fcResp.ok) throw new Error(`forecast HTTP ${fcResp.status}`);
  const data = await fcResp.json();
  return {
    location: {
      name,
      country: country_code,
      region: admin1,
      latitude,
      longitude,
      timezone: data.timezone,
    },
    current: data.current,
    daily: data.daily,
    units: { current: data.current_units, daily: data.daily_units },
  };
}

ipcMain.handle('weather:get', async (_e, args) => {
  const loc = (args && args.location) || '';
  return cachedRead(`weather:${loc.toLowerCase()}`, () => fetchWeather(loc));
});

// --- Obsidian (via mcp-obsidian over the Local REST API plugin) -----------

let obsidianClient = null;
let obsidianInitPromise = null;

async function initObsidianMCP() {
  if (obsidianClient) return obsidianClient;
  if (obsidianInitPromise) return obsidianInitPromise;
  if (!process.env.OBSIDIAN_API_KEY) {
    throw new Error('OBSIDIAN_API_KEY not set in overlay/.env — get it from Obsidian → Settings → Local REST API.');
  }
  obsidianInitPromise = (async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({
      command: '/opt/homebrew/bin/uvx',
      args: ['mcp-obsidian'],
      env: {
        ...process.env,
        OBSIDIAN_API_KEY: process.env.OBSIDIAN_API_KEY,
        OBSIDIAN_HOST: process.env.OBSIDIAN_HOST || '127.0.0.1',
        OBSIDIAN_PORT: process.env.OBSIDIAN_PORT || '27124',
      },
    });
    const client = new Client(
      { name: 'overlay', version: '1.0.0' },
      { capabilities: {} }
    );
    await client.connect(transport);
    obsidianClient = client;
    return client;
  })().catch((err) => {
    obsidianInitPromise = null;
    throw err;
  });
  return obsidianInitPromise;
}

async function callObsidianTool(name, args) {
  const c = await initObsidianMCP();
  const res = await c.callTool({ name, arguments: args || {} });
  const texts = Array.isArray(res.content)
    ? res.content.filter((b) => b && b.type === 'text').map((b) => b.text)
    : [];
  if (res.isError) {
    throw new Error(texts.join('\n').trim() || `obsidian tool ${name} failed`);
  }
  if (!texts.length) return res.content || null;
  if (texts.length === 1) {
    const t = texts[0].trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try { return JSON.parse(t); } catch {}
    }
    return texts[0];
  }
  return texts;
}

ipcMain.handle('obsidian:list_vault', (_e, args) => callObsidianTool('obsidian_list_files_in_vault', args));
ipcMain.handle('obsidian:list_dir', (_e, args) => callObsidianTool('obsidian_list_files_in_dir', args));
ipcMain.handle('obsidian:get_file', (_e, args) => callObsidianTool('obsidian_get_file_contents', args));
ipcMain.handle('obsidian:search', (_e, args) => callObsidianTool('obsidian_simple_search', args));
ipcMain.handle('obsidian:patch', (_e, args) => callObsidianTool('obsidian_patch_content', args));
ipcMain.handle('obsidian:append', (_e, args) => callObsidianTool('obsidian_append_content', args));
ipcMain.handle('obsidian:delete', (_e, args) => callObsidianTool('obsidian_delete_file', args));
ipcMain.handle('obsidian:list_tools', async () => {
  const c = await initObsidianMCP();
  const res = await c.listTools();
  return (res.tools || []).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
});

app.whenReady().then(() => {
  initObsidianMCP().catch((err) => {
    console.error('obsidian-mcp init failed:', err && err.message ? err.message : err);
  });
});

app.on('will-quit', () => {
  if (obsidianClient) {
    obsidianClient.close().catch(() => {});
    obsidianClient = null;
  }
});
