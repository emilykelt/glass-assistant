const { app, BrowserWindow, globalShortcut, ipcMain, shell, desktopCapturer, screen, systemPreferences, powerSaveBlocker, powerMonitor } = require('electron');
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
    roundedCorners: true,
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

// One instance only. A second launch (double-clicking Glass.app again) used to
// spawn a parallel Electron whose helpers killed the first one's renderer,
// leaving a frozen window behind; now it just focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    win.show();
    win.focus();
  });
}

app.whenReady().then(() => {
  powerMonitor.on('on-ac', updateSleepBlock);
  powerMonitor.on('on-battery', updateSleepBlock);
  // Running under the bare Electron binary, so the Dock would otherwise show
  // the Electron logo. The launcher .app carries the same icon as applet.icns.
  if (app.dock) app.dock.setIcon(path.join(__dirname, 'Glass.iconset', 'icon_512x512.png'));
  createWindow();

  const ok = globalShortcut.register('CommandOrControl+Shift+Space', toggleWindow);
  if (!ok) console.warn('Failed to register global shortcut Cmd+Shift+Space');
  const okVoice = globalShortcut.register('CommandOrControl+Shift+M', () => {
    if (!win || win.isDestroyed()) return;
    win.show();
    win.focus();
    win.webContents.send('voice:toggle');
  });
  if (!okVoice) console.warn('Failed to register global shortcut Cmd+Shift+M');

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  voiceStop();
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

// One-hop graph read: return the file plus the contents of the notes it
// [[links]] to. Used only by the read_memory tool — never by the index load
// in buildSystemPrompt (memory.md links to everything, which would balloon the
// prompt). Broken links are skipped silently; they mark notes not yet written.
const MEM_LINK_MAX = 6; // most neighbours to inline
const MEM_LINK_BYTES = 2000; // per-neighbour cap
const MEM_LINK_TOTAL = 8000; // total neighbour bytes cap

function extractWikilinks(text) {
  const out = [];
  const seen = new Set();
  const re = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;
  let match;
  while ((match = re.exec(text))) {
    let target = match[1].trim();
    if (!target) continue;
    if (!target.endsWith('.md')) target += '.md';
    if (seen.has(target)) continue;
    seen.add(target);
    out.push(target);
  }
  return out;
}

ipcMain.handle('memory:readGraph', (_e, rel) => {
  const abs = resolveMemPath(rel);
  if (!fs.existsSync(abs)) throw new Error(`memory file not found: ${rel}`);
  const primary = fs.readFileSync(abs, 'utf8');
  const self = path.resolve(abs);
  const sections = [];
  let budget = MEM_LINK_TOTAL;
  for (const target of extractWikilinks(primary)) {
    if (sections.length >= MEM_LINK_MAX || budget <= 0) break;
    let linkedAbs;
    try {
      linkedAbs = resolveMemPath(target);
    } catch {
      continue; // out-of-tree or malformed link — skip
    }
    if (path.resolve(linkedAbs) === self) continue;
    if (!fs.existsSync(linkedAbs)) continue; // unwritten note — skip silently
    let body = fs.readFileSync(linkedAbs, 'utf8');
    const cap = Math.min(MEM_LINK_BYTES, budget);
    if (Buffer.byteLength(body, 'utf8') > cap) {
      // slice by bytes, then trim any partial trailing UTF-8 sequence
      body = Buffer.from(body, 'utf8').slice(0, cap).toString('utf8').replace(/�+$/, '') + '\n… (truncated)';
    }
    budget -= Buffer.byteLength(body, 'utf8');
    sections.push(`### [[${target}]]\n${body.trim()}`);
  }
  if (!sections.length) return primary;
  return (
    primary.replace(/\s+$/, '') +
    '\n\n---\n## Linked notes (1 hop)\n\n' +
    sections.join('\n\n')
  );
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

// Renderer diagnostics into /tmp/glass-overlay.log (the renderer console is otherwise invisible).
let rlogWindow = 0;
let rlogCount = 0;
ipcMain.on('renderer:log', (_e, msg) => {
  const now = Date.now();
  if (now - rlogWindow > 1000) {
    rlogWindow = now;
    rlogCount = 0;
  }
  if (++rlogCount > 20) return; // a runaway loop must not fill the disk
  console.log(`[renderer ${new Date().toTimeString().slice(0, 8)}] ${String(msg).replace(/[\r\n]+/g, ' ⏎ ')}`);
});

ipcMain.on('window:show', () => {
  if (win && !win.isDestroyed()) win.showInactive();
});

// --- Alarm support: keep the Mac awake while armed and on mains ------------
// Display sleep is fine; system sleep would silence the alarm. Only blocked
// on AC so a forgotten alarm cannot flatten the battery.
let alarmArmed = false;
let sleepBlockId = null;

function updateSleepBlock() {
  const want = alarmArmed && !powerMonitor.isOnBatteryPower();
  if (want && sleepBlockId === null) sleepBlockId = powerSaveBlocker.start('prevent-app-suspension');
  if (!want && sleepBlockId !== null) {
    powerSaveBlocker.stop(sleepBlockId);
    sleepBlockId = null;
  }
}

ipcMain.on('alarm:armed', (_e, armed) => {
  alarmArmed = armed === true;
  updateSleepBlock();
});

ipcMain.handle('system:onBattery', () => powerMonitor.isOnBatteryPower());

// Output volume for the alarm. Static AppleScript with a validated integer.
ipcMain.handle('system:volume', async (_e, level) => {
  const n = Math.round(Number(level));
  if (!Number.isInteger(n) || n < 0 || n > 100) throw new Error('level must be 0-100');
  await runAppleScript(`set volume output volume ${n} without output muted`);
  return n;
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

// ekhelper's ISO8601DateFormatter needs seconds and a zone; the model often
// sends "2026-10-28T22:30". Zone-less strings are local time (JS agrees), and
// everything is normalised to a full UTC instant before it reaches the helper.
function normaliseISO(v) {
  const str = String(v || '').trim();
  if (!str) return '';
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) throw new Error(`bad date: ${str}`);
  return d.toISOString();
}

ipcMain.handle('apple:create_event', async (_e, args) => {
  if (hasHelper()) {
    await ekHelper(['create-event', args.title, normaliseISO(args.startTime), normaliseISO(args.endTime), args.calendarName]);
  } else {
    await runAppleScript(buildCreateEvent(args));
  }
  cacheInvalidate('events:');
  return { ok: true };
});

// Search / update / delete ride on ekhelper only: the AppleScript fallback has
// no stable event identifiers, so without the helper these are unavailable.
function requireHelper(what) {
  if (!hasHelper()) throw new Error(`${what} needs the ekhelper binary (run npm run build:helper)`);
}

ipcMain.handle('apple:search_events', async (_e, args) => {
  requireHelper('search_events');
  const query = String((args && args.query) || '').trim().slice(0, 200);
  if (!query) throw new Error('search_events needs a query');
  const n = Math.min(Math.max(parseInt(args && args.days, 10) || 30, 1), 365);
  return cachedRead(`events:search:${n}:${query.toLowerCase()}`, async () => {
    return (await ekHelper(['search-events', query, String(n)])) || [];
  });
});

ipcMain.handle('apple:update_event', async (_e, args) => {
  requireHelper('update_event');
  const id = String((args && args.eventId) || '').trim();
  if (!id) throw new Error('update_event needs an eventId');
  const out = await ekHelper([
    'update-event',
    id,
    args.startTime ? normaliseISO(args.startTime) : '',
    args.endTime ? normaliseISO(args.endTime) : '',
    args.title ? String(args.title) : '',
  ]);
  cacheInvalidate('events:');
  return out || { ok: true };
});

ipcMain.handle('apple:delete_event', async (_e, args) => {
  requireHelper('delete_event');
  const id = String((args && args.eventId) || '').trim();
  if (!id) throw new Error('delete_event needs an eventId');
  const out = await ekHelper(['delete-event', id]);
  cacheInvalidate('events:');
  return out || { ok: true };
});

ipcMain.handle('apple:get_reminders', async () => {
  return cachedRead('reminders', async () => {
    if (hasHelper()) return await ekHelper(['reminders']);
    const out = await runAppleScript(buildGetReminders());
    return parseReminders(out);
  });
});

// Live calendar + reminder list names, injected into the system prompt each
// turn so the model never guesses (it used to lean on a stale memory note).
ipcMain.handle('apple:calendars', async () => {
  if (!hasHelper()) return { calendars: [], lists: [] };
  return cachedRead('calendars', async () => (await ekHelper(['calendars'])) || { calendars: [], lists: [] });
});

ipcMain.handle('apple:create_reminder', async (_e, args) => {
  if (hasHelper()) {
    await ekHelper(['create-reminder', args.title, args.dueDate ? normaliseISO(args.dueDate) : '', args.listName || '']);
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
// Open-Meteo has outages (timeouts, 503s). Weather is never essential, so an
// outage returns { unavailable: true } and the model leaves weather out,
// instead of the whole tool call failing.

const WEATHER_TIMEOUT_MS = 8000;

class WeatherUnavailable extends Error {}

async function fetchWeather(location) {
  const q = String(location || '').trim();
  if (!q) throw new Error('location required');
  const geoUrl =
    'https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=' +
    encodeURIComponent(q);
  // A geocoder outage should not take weather down with it: treat it as a
  // miss and let Nominatim answer.
  let place = null;
  try {
    const geoResp = await fetch(geoUrl, { signal: AbortSignal.timeout(WEATHER_TIMEOUT_MS) });
    if (geoResp.ok) place = ((await geoResp.json()).results || [])[0] || null;
  } catch {}
  if (!place) {
    // Open-Meteo only matches bare place names ("Cambridge UK" fails, so do
    // street addresses); fall back to Nominatim, which handles both.
    let g;
    try {
      g = await geocode(q);
    } catch (err) {
      if (/no location found/.test(err.message)) throw err;
      throw new WeatherUnavailable(`geocoding: ${err.message}`);
    }
    place = { latitude: g.lat, longitude: g.lng, name: g.name, country_code: '', admin1: '' };
  }
  const { latitude, longitude, name, country_code, admin1, timezone } = place;
  const fcUrl =
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,precipitation` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum` +
    `&forecast_days=3&timezone=${encodeURIComponent(timezone || 'auto')}`;
  let fcResp;
  try {
    fcResp = await fetch(fcUrl, { signal: AbortSignal.timeout(WEATHER_TIMEOUT_MS) });
  } catch (err) {
    throw new WeatherUnavailable(`forecast: ${err.message}`);
  }
  if (fcResp.status === 429 || fcResp.status >= 500) throw new WeatherUnavailable(`forecast HTTP ${fcResp.status}`);
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
  try {
    return await cachedRead(`weather:${loc.toLowerCase()}`, () => fetchWeather(loc));
  } catch (err) {
    if (!(err instanceof WeatherUnavailable)) throw err;
    // Not cached, so the next call retries once the service is back.
    console.warn('weather unavailable:', err.message);
    return { unavailable: true, reason: 'Weather service is down right now.' };
  }
});

// --- Desk creature (Pico W, via the laptop message server) ---------------
// The Pico polls GET /next every 1.5s; we only queue messages. Plain HTTP to
// localhost, so there is no filesystem or AppleScript surface to guard here.
// NOTE: 8765 is also AnkiConnect's default port (see ANKI_URL above). Whichever
// of the two binds first wins, so both channels verify the reply shape below
// rather than trusting whatever is listening. Moving the creature server to a
// free port is the real fix.
const CREATURE_URL = (() => {
  const raw = process.env.CREATURE_URL || 'http://localhost:8765';
  const host = new URL(raw).hostname;
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
    throw new Error(`CREATURE_URL must be loopback, got ${host}`);
  }
  return raw.replace(/\/$/, '');
})();
const CREATURE_MAX_CHARS = 200;

ipcMain.handle('creature:say', async (_e, args) => {
  const text = String((args && args.text) || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CREATURE_MAX_CHARS);
  if (!text) throw new Error('creature:say needs text');
  const res = await fetch(`${CREATURE_URL}/say`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: text,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`creature server returned ${res.status}`);
  const reply = (await res.text()).trim();
  if (reply !== 'queued') {
    throw new Error(`${CREATURE_URL} is not the creature server (replied "${reply.slice(0, 40)}")`);
  }
  return { ok: true, sent: text };
});

// Deliberately not cachedRead: this is a liveness probe, and a 60s-stale
// answer would report a creature that has already dropped off WiFi.
ipcMain.handle('creature:status', async () => {
  try {
    const res = await fetch(`${CREATURE_URL}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`server returned ${res.status}`);
    const body = (await res.text()).trim();            // "ok queued=N"
    const m = body.match(/^ok queued=(\d+)$/);
    if (!m) {
      return { online: false, error: `something other than the creature server is on ${CREATURE_URL}` };
    }
    return { online: true, queued: Number(m[1]) };
  } catch (err) {
    return { online: false, error: String(err.message || err) };
  }
});

// --- Places + map tiles (Nominatim, Overpass, OSM tiles; no API keys) -------
// Cards in the renderer are built from these. Tiles are fetched here and
// returned as data: URLs so the renderer CSP (img-src 'self' data:) stays put.

const GEO_UA = 'GlassOverlay/1.0 (personal macOS desktop overlay)';
const TILE_CACHE_MAX = 400;
const tileCache = new Map(); // tiles are immutable enough to outlive CACHE_TTL_MS

async function geocode(query) {
  const q = String(query || '').trim().slice(0, 300);
  if (!q) throw new Error('query required');
  const url =
    'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1&q=' +
    encodeURIComponent(q);
  const resp = await fetch(url, {
    headers: { 'User-Agent': GEO_UA, 'Accept-Language': 'en' },
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`geocoding HTTP ${resp.status}`);
  const rows = await resp.json();
  if (!rows || !rows.length) throw new Error(`no location found for "${q}"`);
  const r = rows[0];
  return {
    query: q,
    name: r.name || r.display_name,
    display_name: r.display_name,
    lat: parseFloat(r.lat),
    lng: parseFloat(r.lon),
    type: r.type,
  };
}

ipcMain.handle('geo:geocode', async (_e, args) => {
  const q = String((args && args.query) || '').trim().slice(0, 300);
  return cachedRead(`geo:${q.toLowerCase()}`, () => geocode(q));
});

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(lat2 - lat1);
  const dLon = toR(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const PLACE_KINDS = {
  restaurant: '["amenity"~"^(restaurant|fast_food|food_court)$"]',
  cafe: '["amenity"~"^(cafe|ice_cream)$"]',
  bar: '["amenity"~"^(bar|pub|biergarten)$"]',
  food: '["amenity"~"^(restaurant|fast_food|food_court|cafe)$"]',
  supermarket: '["shop"~"^(supermarket|convenience|greengrocer|bakery)$"]',
  pharmacy: '["amenity"="pharmacy"]',
  atm: '["amenity"~"^(atm|bank)$"]',
  hotel: '["tourism"~"^(hotel|hostel|guest_house)$"]',
  gym: '["leisure"~"^(fitness_centre|sports_centre)$"]',
  park: '["leisure"~"^(park|garden)$"]',
  station: '["railway"~"^(station|halt|tram_stop)$"]',
  attraction: '["tourism"~"^(attraction|museum|gallery|viewpoint)$"]',
  coworking: '["amenity"~"^(coworking_space|library)$"]',
};

// Public Overpass instances 504 under load fairly often; rotate through
// mirrors and retry once before giving up.
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
async function overpassQuery(query) {
  const errs = [];
  // Primary twice (it 504s transiently under load), then each mirror once.
  const plan = [OVERPASS_URLS[0], OVERPASS_URLS[0], ...OVERPASS_URLS.slice(1)];
  for (const url of plan) {
    const t = Date.now();
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': GEO_UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(12000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (err) {
      const msg = `${new URL(url).host}: ${err && err.name === 'TimeoutError' ? 'timeout' : err.message} (${Date.now() - t}ms)`;
      console.warn('overpass', msg);
      errs.push(msg);
    }
  }
  throw new Error('Overpass (OpenStreetMap places) unavailable — ' + errs.join('; '));
}

async function placesNearby({ lat, lng, radius, kind, limit }) {
  const la = Number(lat);
  const lo = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) throw new Error('lat/lng required');
  const r = Math.min(Math.max(Math.round(Number(radius) || 400), 50), 3000);
  const k = String(kind || 'restaurant').toLowerCase();
  const filter = PLACE_KINDS[k];
  if (!filter) throw new Error(`unknown kind "${k}"; use one of ${Object.keys(PLACE_KINDS).join(', ')}`);
  const n = Math.min(Math.max(parseInt(limit, 10) || 12, 1), 30);
  const query =
    `[out:json][timeout:20];nwr(around:${r},${la},${lo})${filter}["name"];out center ${Math.min(n * 4, 120)};`;
  const data = await overpassQuery(query);
  const seen = new Set();
  const places = [];
  for (const el of data.elements || []) {
    const t = el.tags || {};
    const plat = el.lat ?? (el.center && el.center.lat);
    const plng = el.lon ?? (el.center && el.center.lon);
    if (!t.name || !Number.isFinite(plat) || !Number.isFinite(plng)) continue;
    const key = t.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const dist = Math.round(haversine(la, lo, plat, plng));
    places.push({
      name: t.name,
      lat: plat,
      lng: plng,
      distance_m: dist,
      walk_min: Math.max(1, Math.round(dist / 80)),
      category: t.amenity || t.shop || t.tourism || t.leisure || t.railway || null,
      cuisine: t.cuisine || null,
      opening_hours: t.opening_hours || null,
      website: t.website || t['contact:website'] || null,
      phone: t.phone || t['contact:phone'] || null,
    });
  }
  places.sort((a, b) => a.distance_m - b.distance_m);
  return { center: { lat: la, lng: lo }, radius_m: r, kind: k, places: places.slice(0, n) };
}

ipcMain.handle('places:nearby', async (_e, args) => {
  const a = args || {};
  const key = `places:${Number(a.lat).toFixed(4)},${Number(a.lng).toFixed(4)}:${a.radius || ''}:${a.kind || ''}:${a.limit || ''}`;
  return cachedRead(key, () => placesNearby(a));
});

async function fetchTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  const hit = tileCache.get(key);
  if (hit) return hit;
  const resp = await fetch(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`, {
    headers: { 'User-Agent': GEO_UA },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`tile HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const url = 'data:image/png;base64,' + buf.toString('base64');
  if (tileCache.size >= TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
  tileCache.set(key, url);
  return url;
}

ipcMain.handle('map:tiles', async (_e, args) => {
  const a = args || {};
  const z = parseInt(a.z, 10);
  if (!Number.isInteger(z) || z < 1 || z > 19) throw new Error('z out of range');
  const list = Array.isArray(a.tiles) ? a.tiles.slice(0, 20) : [];
  const max = 2 ** z;
  const out = await Promise.all(
    list.map(async (t) => {
      const x = parseInt(t && t[0], 10);
      const y = parseInt(t && t[1], 10);
      if (!Number.isInteger(x) || !Number.isInteger(y) || y < 0 || y >= max) return null;
      const wx = ((x % max) + max) % max; // wrap longitude
      try {
        return { x, y, url: await fetchTile(z, wx, y) };
      } catch {
        return null;
      }
    })
  );
  return out.filter(Boolean);
});

// --- Spotify (Web API with PKCE; AppleScript fallback for local playback) ---
// Search + playback ride on the Web API so the model can compose free-text
// mood queries rather than picking from a fixed playlist map. Tokens rotate,
// so they live in userData (not .env). Album art is fetched here and returned
// as a data: URL, like map tiles, so the renderer CSP (img-src 'self' data:)
// stays untouched. The desktop app is the fallback when the Web API has no
// active device (nothing playing yet) or the account is not Premium (403).

const SPOTIFY_SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing';
const SPOTIFY_REDIRECT_PORT = 8899;
const SPOTIFY_REDIRECT_URI = `http://127.0.0.1:${SPOTIFY_REDIRECT_PORT}/callback`;
const SPOTIFY_KINDS = ['auto', 'playlist', 'track', 'album', 'artist'];
const SPOTIFY_URI_RE = /^spotify:(track|playlist|album|artist):[A-Za-z0-9]+$/;
const spotifyTokenFile = () => path.join(app.getPath('userData'), 'spotify-tokens.json');
let spotifyTokens = null;
let spotifyAuthPromise = null;

function spotifyClientId() {
  const id = process.env.SPOTIFY_CLIENT_ID;
  if (!id) {
    throw new Error(
      `SPOTIFY_CLIENT_ID not set in overlay/.env — create an app at developer.spotify.com/dashboard with redirect URI ${SPOTIFY_REDIRECT_URI}`
    );
  }
  return id;
}

function loadSpotifyTokens() {
  if (spotifyTokens) return spotifyTokens;
  try {
    spotifyTokens = JSON.parse(fs.readFileSync(spotifyTokenFile(), 'utf8'));
  } catch {
    spotifyTokens = null;
  }
  return spotifyTokens;
}

function saveSpotifyTokens(t) {
  spotifyTokens = t;
  fs.writeFileSync(spotifyTokenFile(), JSON.stringify(t), { mode: 0o600 });
}

async function spotifyTokenRequest(params) {
  const resp = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: spotifyClientId(), ...params }).toString(),
    signal: AbortSignal.timeout(10000),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Spotify token ${resp.status}: ${data.error_description || data.error || 'unknown'}`);
  return {
    access_token: data.access_token,
    // PKCE refreshes rotate the refresh token; keep the old one if none came back.
    refresh_token: data.refresh_token || (spotifyTokens && spotifyTokens.refresh_token),
    expires_at: Date.now() + (data.expires_in || 3600) * 1000 - 30000,
  };
}

// One-time login: a tiny loopback listener catches the redirect from a
// popup BrowserWindow. Process-wide singleton so parallel tool calls share it.
function spotifyAuthorize() {
  if (spotifyAuthPromise) return spotifyAuthPromise;
  spotifyAuthPromise = new Promise((resolve, reject) => {
    const crypto = require('crypto');
    const http = require('http');
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(12).toString('hex');
    let authWin = null;
    let done = false;
    let timer = null;
    const finish = (err, tokens) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      server.close();
      spotifyAuthPromise = null;
      if (authWin && !authWin.isDestroyed()) authWin.close();
      if (err) reject(err);
      else resolve(tokens);
    };
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, SPOTIFY_REDIRECT_URI);
      if (u.pathname !== '/callback') {
        res.writeHead(404);
        res.end();
        return;
      }
      if (u.searchParams.get('state') !== state) {
        // Stray local request: ignore it rather than letting it abort a real login.
        res.writeHead(400);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<body style="font-family:-apple-system,sans-serif;background:#16161c;color:#eee;padding:2em">Glass is connected to Spotify. You can close this window.</body>');
      const code = u.searchParams.get('code');
      if (!code) return finish(new Error(`Spotify login denied: ${u.searchParams.get('error') || 'no code'}`));
      try {
        const t = await spotifyTokenRequest({
          grant_type: 'authorization_code',
          code,
          redirect_uri: SPOTIFY_REDIRECT_URI,
          code_verifier: verifier,
        });
        saveSpotifyTokens(t);
        finish(null, t);
      } catch (e) {
        finish(e);
      }
    });
    server.on('error', (e) => finish(new Error(`Spotify auth listener: ${e.message}`)));
    timer = setTimeout(() => finish(new Error('Spotify login timed out')), 3 * 60 * 1000);
    server.listen(SPOTIFY_REDIRECT_PORT, '127.0.0.1', () => {
      let url;
      try {
        url =
          'https://accounts.spotify.com/authorize?' +
          new URLSearchParams({
            client_id: spotifyClientId(),
            response_type: 'code',
            redirect_uri: SPOTIFY_REDIRECT_URI,
            scope: SPOTIFY_SCOPES,
            code_challenge_method: 'S256',
            code_challenge: challenge,
            state,
          }).toString();
      } catch (e) {
        return finish(e);
      }
      authWin = new BrowserWindow({
        width: 480,
        height: 720,
        alwaysOnTop: true,
        title: 'Connect Spotify',
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
      });
      authWin.on('closed', () => {
        authWin = null;
        finish(new Error('Spotify login window closed'));
      });
      authWin.loadURL(url);
    });
  });
  return spotifyAuthPromise;
}

async function spotifyAccessToken() {
  let t = loadSpotifyTokens();
  if (!t || !t.refresh_token) t = await spotifyAuthorize();
  if (Date.now() >= t.expires_at) {
    try {
      t = await spotifyTokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
      saveSpotifyTokens(t);
    } catch {
      // Refresh token revoked or expired: log in again.
      t = await spotifyAuthorize();
    }
  }
  return t.access_token;
}

async function spotifyApi(method, pathname, { query, body } = {}) {
  const token = await spotifyAccessToken();
  const url = 'https://api.spotify.com/v1' + pathname + (query ? '?' + new URLSearchParams(query).toString() : '');
  const resp = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!resp.ok) {
    const err = new Error(`Spotify ${resp.status}: ${(data && data.error && data.error.message) || resp.statusText}`);
    err.status = resp.status;
    err.reason = data && data.error && data.error.reason;
    throw err;
  }
  return data;
}

function slimSpotifyItem(it, type) {
  if (!it || !it.uri || !SPOTIFY_URI_RE.test(it.uri)) return null;
  const imgs = it.images || (it.album && it.album.images) || [];
  // Images come largest-first (640/300/64); the middle one suits a card.
  const art = (imgs[1] || imgs[0] || {}).url || null;
  const artists = (it.artists || []).map((a) => a && a.name).filter(Boolean).join(', ');
  return {
    type,
    uri: it.uri,
    name: it.name || '',
    by: type === 'playlist' ? (it.owner && it.owner.display_name) || '' : artists,
    album: type === 'track' && it.album ? it.album.name : undefined,
    duration_ms: it.duration_ms,
    url: it.external_urls && it.external_urls.spotify,
    art,
  };
}

async function spotifySearch(q, kind, limit) {
  const types = kind === 'auto' ? 'playlist,track' : kind;
  const data = await spotifyApi('GET', '/search', { query: { q, type: types, limit: String(limit) } });
  const out = [];
  for (const t of types.split(',')) {
    const page = data && data[t + 's'];
    // Playlist search is known to return null entries; slim() drops them.
    ((page && page.items) || []).forEach((it) => {
      const s = slimSpotifyItem(it, t);
      if (s) out.push(s);
    });
  }
  return out;
}

const artCache = new Map();
const ART_CACHE_MAX = 60;

async function fetchSpotifyArt(url) {
  if (!url) return null;
  const host = new URL(url).hostname;
  if (!(host.endsWith('.scdn.co') || host.endsWith('.spotifycdn.com'))) return null;
  const hit = artCache.get(url);
  if (hit) return hit;
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) return null;
  const buf = Buffer.from(await resp.arrayBuffer());
  const data = `data:${resp.headers.get('content-type') || 'image/jpeg'};base64,${buf.toString('base64')}`;
  if (artCache.size >= ART_CACHE_MAX) artCache.delete(artCache.keys().next().value);
  artCache.set(url, data);
  return data;
}

const buildSpotifyPlay = (uri) => `tell application "Spotify"
  activate
  play track "${escapeAS(uri)}"
end tell`;

const SPOTIFY_AS_CONTROL = {
  pause: 'tell application "Spotify" to pause',
  resume: 'tell application "Spotify" to play',
  next: 'tell application "Spotify" to next track',
  previous: 'tell application "Spotify" to previous track',
};

const SPOTIFY_API_CONTROL = {
  pause: ['PUT', '/me/player/pause'],
  resume: ['PUT', '/me/player/play'],
  next: ['POST', '/me/player/next'],
  previous: ['POST', '/me/player/previous'],
};

const spotifyNeedsLocalFallback = (e) => e && (e.status === 404 || e.status === 403);

async function spotifyPlay(item) {
  const body = item.type === 'track' ? { uris: [item.uri] } : { context_uri: item.uri };
  try {
    await spotifyApi('PUT', '/me/player/play', { body });
    return 'web';
  } catch (e) {
    if (!spotifyNeedsLocalFallback(e)) throw e;
    if (!SPOTIFY_URI_RE.test(item.uri)) throw e;
    await runAppleScript(buildSpotifyPlay(item.uri));
    return 'app';
  }
}

async function spotifyNow() {
  const d = await spotifyApi('GET', '/me/player/currently-playing');
  if (!d || !d.item) return { playing: false };
  const item = slimSpotifyItem(d.item, d.item.type === 'episode' ? 'track' : d.item.type || 'track') || {};
  const now = { playing: !!d.is_playing, progress_ms: d.progress_ms, ...item };
  now.art_data = await fetchSpotifyArt(now.art).catch(() => null);
  return now;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ipcMain.handle('spotify:play', async (_e, args) => {
  const a = args || {};
  const q = String(a.query || '').trim().slice(0, 200);
  if (!q) throw new Error('query required');
  const kind = SPOTIFY_KINDS.includes(a.kind) ? a.kind : 'auto';
  const results = await cachedRead(`spotify:search:${kind}:${q.toLowerCase()}`, () => spotifySearch(q, kind, 5));
  if (!results.length) throw new Error(`Nothing on Spotify for "${q}"`);
  const pick = (kind === 'auto' && results.find((r) => r.type === 'playlist')) || results[0];
  const via = await spotifyPlay(pick);
  const alternatives = results.filter((r) => r !== pick).slice(0, 4).map(({ art, ...r }) => r);
  // A playlist/album pick is a context, not a track: report the track that
  // actually started so the card shows a song, with the context as a tag.
  await sleep(700);
  const now = await spotifyNow().catch(() => null);
  if (now && now.name) {
    return { ...now, playing: true, via, query: q, context: pick.type === 'track' ? undefined : { type: pick.type, name: pick.name }, alternatives };
  }
  const art_data = await fetchSpotifyArt(pick.art).catch(() => null);
  return { playing: true, via, query: q, ...pick, art_data, alternatives };
});

ipcMain.handle('spotify:control', async (_e, args) => {
  const action = args && args.action;
  if (!SPOTIFY_API_CONTROL[action]) throw new Error('action must be pause, resume, next or previous');
  try {
    const [method, p] = SPOTIFY_API_CONTROL[action];
    await spotifyApi(method, p);
  } catch (e) {
    if (!spotifyNeedsLocalFallback(e)) throw e;
    await runAppleScript(SPOTIFY_AS_CONTROL[action]);
  }
  await sleep(350); // player state lags the command slightly
  return spotifyNow();
});

// Deliberately not cachedRead: playback state changes every second.
// `quiet` skips the login popup: used by the radio host to check whether music
// is on without ever prompting.
ipcMain.handle('spotify:now', async (_e, args) => {
  if (args && args.quiet && !loadSpotifyTokens()) return { playing: false };
  return spotifyNow();
});

// Ducking for spoken interjections. AppleScript, not the Web API: it works
// without Premium and the desktop app is where local playback lives. Static
// scripts; the level is validated to an integer 0-100 before interpolation.
ipcMain.handle('spotify:volume', async (_e, level) => {
  const running = (await runAppleScript('tell application "System Events" to (name of processes) contains "Spotify"')).trim() === 'true';
  if (!running) return null;
  const prev = parseInt(await runAppleScript('tell application "Spotify" to sound volume'), 10);
  const n = Math.round(Number(level));
  if (!Number.isInteger(n) || n < 0 || n > 100) throw new Error('level must be 0-100');
  await runAppleScript(`tell application "Spotify" to set sound volume to ${n}`);
  return Number.isInteger(prev) ? prev : null;
});

// --- Voice (Deepgram: Nova STT over WebSocket, Aura TTS over REST) --------
// The renderer captures the mic and streams 16 kHz PCM here over IPC; main
// owns the Deepgram socket and the API key, and pushes transcript events back
// with webContents.send. TTS audio is returned as a data: URL (CSP media-src).
// Node 22's global WebSocket cannot set headers, so auth rides on the
// `token` subprotocol, which Deepgram accepts.

const DG_STT_URL =
  'wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=16000&channels=1' +
  '&smart_format=true&interim_results=true&endpointing=400&utterance_end_ms=1200&vad_events=true';
// v2 speak API: Flux voices (flux-*-en) take speed + expressivity; Aura-2 ids work here too.
const DG_TTS_VOICE = process.env.DEEPGRAM_VOICE || 'aura-2-athena-en';
const DG_TTS_SPEED = process.env.DEEPGRAM_SPEED || '1';
const DG_TTS_EXPRESSIVITY = process.env.DEEPGRAM_EXPRESSIVITY || '0';
let dgSocket = null;
let dgKeepAlive = null;
let dgGeneration = 0; // bumps per voice:start so a superseded connect attempt closes itself

function deepgramKey() {
  const k = process.env.DEEPGRAM_API_KEY;
  if (!k) throw new Error('DEEPGRAM_API_KEY not set in overlay/.env');
  return k;
}

function voiceEmit(ev) {
  if (win && !win.isDestroyed()) win.webContents.send('voice:event', ev);
}

function voiceStop() {
  clearInterval(dgKeepAlive);
  dgKeepAlive = null;
  const ws = dgSocket;
  dgSocket = null;
  if (!ws) return;
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'CloseStream' })); // flushes final results first
    } catch {}
  }
  setTimeout(() => {
    try {
      ws.close();
    } catch {}
  }, 500);
}

ipcMain.handle('voice:start', async () => {
  const key = deepgramKey();
  if (process.platform === 'darwin') {
    const ok = await systemPreferences.askForMediaAccess('microphone');
    if (!ok) throw new Error('Microphone access denied — System Settings → Privacy & Security → Microphone');
  }
  voiceStop();
  const gen = ++dgGeneration;
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(DG_STT_URL, ['token', key]);
    ws.binaryType = 'arraybuffer';
    const timer = setTimeout(() => {
      reject(new Error('Deepgram connect timed out'));
      try {
        ws.close();
      } catch {}
    }, 8000);
    ws.onopen = () => {
      clearTimeout(timer);
      if (gen !== dgGeneration) {
        // A newer voice:start superseded this connect; don't orphan an open socket.
        try {
          ws.close();
        } catch {}
        return reject(new Error('superseded'));
      }
      dgSocket = ws;
      dgKeepAlive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' }));
      }, 5000);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('Deepgram connection failed (check DEEPGRAM_API_KEY)'));
    };
    ws.onmessage = (m) => {
      let d;
      try {
        d = JSON.parse(m.data);
      } catch {
        return;
      }
      if (d.type === 'Results') {
        const alt = d.channel && d.channel.alternatives && d.channel.alternatives[0];
        voiceEmit({
          type: 'transcript',
          text: (alt && alt.transcript) || '',
          final: !!d.is_final,
          speechFinal: !!d.speech_final,
        });
      } else if (d.type === 'UtteranceEnd') {
        voiceEmit({ type: 'utterance_end' });
      } else if (d.type === 'Error') {
        voiceEmit({ type: 'error', message: d.message || d.description || 'Deepgram error' });
      }
    };
    ws.onclose = () => {
      if (dgSocket === ws) {
        voiceStop();
        voiceEmit({ type: 'closed' });
      }
    };
  });
  return true;
});

ipcMain.on('voice:audio', (_e, chunk) => {
  // 4096 frames of Int16 is 8 KB; anything much larger is not our capture loop.
  if (!chunk || chunk.byteLength > 65536) return;
  if (dgSocket && dgSocket.readyState === WebSocket.OPEN) dgSocket.send(chunk);
});

ipcMain.handle('voice:stop', () => {
  voiceStop();
  return true;
});

// Long text (the morning briefing) in one request overran Deepgram's latency,
// so split on sentences into ~500-char chunks, fetch in parallel, and join the
// MP3 streams: Chromium plays concatenated MP3 frames as one clip.
function splitForTts(text, max) {
  const out = [];
  let cur = '';
  for (const sent of text.split(/(?<=[.!?])\s+/)) {
    if (cur && cur.length + sent.length + 1 > max) {
      out.push(cur);
      cur = sent;
    } else {
      cur = cur ? `${cur} ${sent}` : sent;
    }
  }
  if (cur) out.push(cur);
  return out.map((c) => c.slice(0, max));
}

async function ttsChunk(text) {
  const isFlux = DG_TTS_VOICE.startsWith('flux-');
  const params = new URLSearchParams(
    isFlux
      ? { model: DG_TTS_VOICE, speed: DG_TTS_SPEED, expressivity: DG_TTS_EXPRESSIVITY, encoding: 'mp3' }
      : { model: DG_TTS_VOICE, encoding: 'mp3' }
  );
  const resp = await fetch(`https://api.deepgram.com/${isFlux ? 'v2' : 'v1'}/speak?${params}`, {
    method: 'POST',
    headers: { Authorization: `Token ${deepgramKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(45000),
  });
  if (!resp.ok) throw new Error(`Deepgram TTS ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  return Buffer.from(await resp.arrayBuffer());
}

ipcMain.handle('voice:speak', async (_e, args) => {
  const text = String((args && args.text) || '').trim().slice(0, 4000);
  if (!text) return null;
  const parts = await Promise.all(splitForTts(text, 500).map(ttsChunk));
  return 'data:audio/mpeg;base64,' + Buffer.concat(parts).toString('base64');
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
    // Prefer the persistent uv tool install (~1.8s to connect). `uvx` is only a
    // fallback: it re-resolves an ad-hoc environment on every launch, which takes
    // over a minute and makes startup race itself.
    // Either way `mcp<2` is load-bearing — mcp 2.0.0 dropped `Server.list_tools`,
    // which mcp-obsidian 0.2.2 decorates at import time, so an unpinned resolve
    // kills the server and every Obsidian tool with it.
    //   Reinstall with: uv tool install mcp-obsidian --with 'mcp<2'
    const installed = path.join(require('os').homedir(), '.local/bin/mcp-obsidian');
    const useInstalled = fs.existsSync(installed);
    const transport = new StdioClientTransport({
      command: useInstalled ? installed : '/opt/homebrew/bin/uvx',
      args: useInstalled ? [] : ['--with', 'mcp<2', 'mcp-obsidian'],
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

// --- People CRM (Career/People/ in the Obsidian vault) --------------------
// Low-friction capture for the contact graph. Rides on the Obsidian MCP client
// above rather than touching the filesystem, so there is no new path surface.

const PEOPLE_DIR = 'Career/People';
const PERSON_KEEP = ['type', 'status', 'company', 'knows', 'last_contact', 'next_step'];

function personPath(name) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('person name is required');
  if (/[\/\\]/.test(clean) || clean.includes('..')) {
    throw new Error(`invalid person name: ${clean}`);
  }
  return `${PEOPLE_DIR}/${clean}.md`;
}

function parseFrontmatter(md) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(String(md || ''));
  if (!m) return { fm: {}, body: String(md || '') };
  const fm = {};
  let key = null;
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      fm[key] = kv[2].trim();
      continue;
    }
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && key) {
      if (!Array.isArray(fm[key])) fm[key] = fm[key] ? [fm[key]] : [];
      fm[key].push(item[1].trim().replace(/^["']|["']$/g, ''));
    }
  }
  return { fm, body: m[2] };
}

function asList(v) {
  if (Array.isArray(v)) return v.filter(Boolean);
  const s = String(v || '').trim();
  return s ? [s] : [];
}

function buildPerson(fm, body) {
  const out = ['---'];
  for (const k of PERSON_KEEP) {
    if (!(k in fm)) continue;
    if (k === 'knows') {
      out.push('knows:');
      for (const it of asList(fm.knows)) out.push(`  - "${it}"`);
    } else {
      out.push(`${k}: ${fm[k] == null ? '' : fm[k]}`);
    }
  }
  out.push('---');
  return out.join('\n') + '\n\n' + String(body).replace(/^\n+/, '').replace(/\s*$/, '') + '\n';
}

function addLogEntry(body, note, date) {
  const entry = `- **${date}** — ${String(note).trim()}`;
  if (/^## Log\s*$/m.test(body)) return body.replace(/^## Log\s*$/m, `## Log\n\n${entry}`);
  const tail = /\n\[\[People\]\]\s*$/;
  if (tail.test(body)) return body.replace(tail, `\n\n## Log\n\n${entry}\n\n[[People]]\n`);
  return body.replace(/\s*$/, '') + `\n\n## Log\n\n${entry}\n`;
}

async function readPerson(filepath) {
  try {
    const md = await callObsidianTool('obsidian_get_file_contents', { filepath });
    return typeof md === 'string' ? md : null;
  } catch {
    return null;
  }
}

async function overwriteNote(filepath, content) {
  // The Obsidian MCP surface has no replace-file verb, so delete + append is the
  // only route. Retry once, and surface the content on total failure so a note
  // can never be silently lost between the two calls.
  await callObsidianTool('obsidian_delete_file', { filepath }).catch(() => {});
  try {
    await callObsidianTool('obsidian_append_content', { filepath, content });
  } catch {
    try {
      await callObsidianTool('obsidian_append_content', { filepath, content });
    } catch {
      throw new Error(`Failed to write ${filepath}. Content preserved below:\n\n${content}`);
    }
  }
}

ipcMain.handle('person:capture', async (_e, args) => {
  const a = args || {};
  const name = String(a.name || '').trim();
  const filepath = personPath(name);
  const existing = await readPerson(filepath);

  const { fm, body } = existing
    ? parseFrontmatter(existing)
    : {
        fm: { type: 'person', status: '', company: '', knows: [], last_contact: '', next_step: '' },
        // #crm is inline rather than a frontmatter `tags` field, to keep the
        // five-field schema intact. Obsidian indexes both identically.
        body: `# ${name}\n\n#crm\n\n[[People]]\n`,
      };

  fm.type = 'person';
  for (const f of ['status', 'company', 'last_contact', 'next_step']) {
    if (a[f] != null && String(a[f]).trim() !== '') fm[f] = String(a[f]).trim();
    else if (!(f in fm)) fm[f] = '';
  }

  const edges = [];
  const cur = asList(fm.knows);
  for (const raw of asList(a.knows)) {
    const other = String(raw).replace(/^\[\[|\]\]$/g, '').trim();
    if (!other || other === name) continue;
    const link = `[[${other}]]`;
    if (!cur.includes(link)) {
      cur.push(link);
      edges.push(other);
    }
  }
  fm.knows = cur;

  let nextBody = body;
  if (a.note && String(a.note).trim()) {
    nextBody = addLogEntry(nextBody, a.note, new Date().toISOString().slice(0, 10));
  }

  await overwriteNote(filepath, buildPerson(fm, nextBody));
  cacheInvalidate('person:');
  return { filepath, created: !existing, edges_added: edges };
});

ipcMain.handle('person:list', async () =>
  cachedRead('person:list', async () => {
    const files = await callObsidianTool('obsidian_list_files_in_dir', { dirpath: PEOPLE_DIR });
    const names = (Array.isArray(files) ? files : []).filter(
      (f) => typeof f === 'string' && f.endsWith('.md')
    );
    return Promise.all(
      names.map(async (f) => {
        const { fm } = parseFrontmatter((await readPerson(`${PEOPLE_DIR}/${f}`)) || '');
        return {
          name: f.replace(/\.md$/, ''),
          status: fm.status || '',
          company: fm.company || '',
          knows: asList(fm.knows).map((s) => s.replace(/^\[\[|\]\]$/g, '')),
          last_contact: fm.last_contact || '',
          next_step: fm.next_step || '',
        };
      })
    );
  })
);

// --- Health log (Health/ in the Obsidian vault) ---------------------------
// Append-only symptom/health diary. Rides on the Obsidian MCP client like the
// CRM, so there is no new path surface: the file path is a constant.
//
// Body locations are stored as a compact code rather than an image. The
// renderer's figure is a 100x200 box split into 5-unit cells (20 cols x 40
// rows = 800 per view); the user shades cells at an intensity 1-10:
//   <F|B><intensity>:<run>(,<run>)*   parts joined by ';'   run = idx | idx-idx
// idx = row*20 + col. e.g. F7:612-614,632-634;B3:340-342. The renderer
// redraws the same grid from this, so the entry is fully recreatable.

const HEALTH_LOG = 'Health/Health Log.md';
const HEALTH_KINDS = ['pain', 'symptom', 'illness', 'injury', 'sleep', 'medication', 'mood', 'energy', 'exercise', 'diet', 'appointment', 'other'];
const BODY_RUNS = '(10|[1-9]):\\d{1,3}(-\\d{1,3})?(,\\d{1,3}(-\\d{1,3})?)*';
const BODY_CODE_RE = new RegExp(`^[FB]${BODY_RUNS}(;[FB]${BODY_RUNS})*$`);

const HEALTH_LOG_HEADER = `# Health Log

#health

Append-only diary written by Glass. One line per entry, newest last:

\`- **YYYY-MM-DD HH:MM** · kind · region · severity/10 · for duration · \`body-code\` · summary — notes\`

Fields after the timestamp are omitted when unknown. The body code encodes the area the user shaded on Glass's body diagram, without storing an image. The figure is a 100x200 box cut into 5-unit cells, 20 columns by 40 rows, indexed row*20+col from the top-left (viewer's perspective, so the figure's left is the user's right on the front view). Each part is \`F\` front or \`B\` back, the intensity 1-10, a colon, then comma-separated cell runs; parts join with \`;\`. Example: \`F7:612-614,632-634\` = front view, intensity 7, cells 612-614 and 632-634 (a 3x2 patch on the left knee). Glass redraws the shading from this code.

## Entries

`;

function oneLine(v, max) {
  // Also neutralise the ' · ' field delimiter so a value cannot shift its own entry's fields.
  return String(v == null ? '' : v).replace(/\s+/g, ' ').replace(/ · /g, ' - ').trim().slice(0, max);
}

ipcMain.handle('health:log', async (_e, args) => {
  const a = args || {};
  const kind = oneLine(a.kind, 20).toLowerCase() || 'other';
  if (!HEALTH_KINDS.includes(kind)) throw new Error(`invalid kind: ${kind}`);
  const summary = oneLine(a.summary, 300);
  if (!summary) throw new Error('summary is required');
  let body = oneLine(a.body, 1500).replace(/\s+/g, '');
  if (body && !BODY_CODE_RE.test(body)) throw new Error(`invalid body code: ${body}`);
  let severity = a.severity == null || a.severity === '' ? null : Math.round(Number(a.severity));
  if (severity != null && !(severity >= 1 && severity <= 10)) severity = null;
  const regions = Array.isArray(a.regions) ? a.regions.map((r) => oneLine(r, 40)).filter(Boolean).slice(0, 6) : [];
  const notes = oneLine(a.notes, 600);
  const duration = oneLine(a.duration, 60).replace(/^for /i, '');

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const parts = [`**${stamp}**`, kind];
  if (regions.length) parts.push(regions.join(', '));
  if (severity != null) parts.push(`${severity}/10`);
  if (duration) parts.push(`for ${duration}`);
  if (body) parts.push(`\`${body}\``);
  parts.push(notes ? `${summary} — ${notes}` : summary);
  const line = `- ${parts.join(' · ')}`;

  let existing = null;
  try {
    existing = await callObsidianTool('obsidian_get_file_contents', { filepath: HEALTH_LOG });
  } catch (err) {
    // Only a missing file gets the header; any other read failure must not
    // append a second header into the middle of the log.
    if (!/not found|404|does not exist|no such file/i.test(String(err && err.message))) throw err;
  }
  const content = existing == null ? HEALTH_LOG_HEADER + line + '\n' : line + '\n';
  await callObsidianTool('obsidian_append_content', { filepath: HEALTH_LOG, content });
  cacheInvalidate('health:');
  return { filepath: HEALTH_LOG, date: stamp, kind, regions, severity, duration, body, summary, notes };
});

function parseHealthLine(line) {
  const m = /^- \*\*(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\*\* · (.*)$/.exec(line);
  if (!m) return null;
  const rest = m[3].split(' · ');
  const entry = { date: m[1], time: m[2], kind: rest.shift() || 'other', regions: [], severity: null, duration: '', body: '', text: '' };
  while (rest.length > 1) {
    const f = rest[0];
    const sev = /^(\d{1,2})\/10$/.exec(f);
    const code = /^`([FB](?:10|[1-9]):[\d,;:FB-]*)`$/.exec(f);
    const dur = /^for (.+)$/.exec(f);
    if (sev) entry.severity = Number(sev[1]);
    else if (code) entry.body = code[1];
    else if (dur) entry.duration = dur[1];
    else entry.regions = f.split(', ').filter(Boolean);
    rest.shift();
  }
  entry.text = rest.join(' · ');
  return entry;
}

ipcMain.handle('health:list', async (_e, args) => {
  const a = args || {};
  const days = Math.min(3650, Math.max(1, Number(a.days) || 90));
  const query = oneLine(a.query, 80).toLowerCase();
  const all = await cachedRead('health:list', async () => {
    const md = await readPerson(HEALTH_LOG);
    return (md || '').split('\n').map(parseHealthLine).filter(Boolean);
  });
  const since = new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10);
  return all
    .filter((e) => e.date >= since)
    .filter((e) => !query || [e.kind, e.regions.join(' '), e.duration, e.text].join(' ').toLowerCase().includes(query))
    .slice(-200);
});

// --- Lunch menus ------------------------------------------------------------
// Fixed sources, so the only input reaching a URL is a regex-checked date.
const TROUGH_URL = 'https://whats-for-trough.vercel.app/';
const WEST_HUB_URL = 'https://www.catering.admin.cam.ac.uk/cafes/west-hub-canteen';
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

const MENU_MAX_BYTES = 500 * 1024;
const MENU_MAX_TEXT = 200;

function htmlText(s) {
  return String(s).slice(0, MENU_MAX_BYTES)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#0?39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MENU_MAX_TEXT);
}

async function fetchMenuPage(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': GEO_UA },
    signal: AbortSignal.timeout(12000),
  });
  if (!resp.ok) throw new Error(`menu fetch failed: HTTP ${resp.status}`);
  const html = await resp.text();
  if (html.length > MENU_MAX_BYTES) throw new Error('menu page unexpectedly large');
  return html;
}

function parseTroughMenu(html, date) {
  const displayDate = htmlText((html.match(/<p class="text-white[^"]*">(.*?)<\/p>/s) || [])[1] || '');
  const expected = new Date(`${date}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }).replace(',', '');
  if (displayDate !== expected) {
    return { venue: 'Pembroke servery', date, displayDate, meals: [], note: `No menu available for this date: the site showed ${displayDate || 'no date'}.` };
  }
  if (html.includes('No menu today')) {
    return { venue: 'Pembroke servery', date, displayDate, meals: [], note: 'No menu: not uploaded during the break.' };
  }
  const meals = [...html.matchAll(/<section>(.*?)<\/section>/gs)].map(([, body]) => {
    const meal = htmlText((body.match(/<h2[^>]*>(.*?)<\/h2>/s) || [])[1] || '');
    const hours = htmlText((body.match(/<\/h2>\s*<p[^>]*>(.*?)<\/p>/s) || [])[1] || '');
    const rest = body.replace(/^.*?<\/h2>\s*<p[^>]*>.*?<\/p>/s, '');
    const out = { meal, hours, dishes: [] };
    const rows = rest.matchAll(/<p class="[^"]*uppercase[^"]*">(.*?)<\/p>(.*?)(?=<p class="[^"]*uppercase|$)/gs);
    for (const [, label, value] of rows) {
      const name = htmlText(label);
      if (name === 'Sides') out.sides = [...value.matchAll(/<li[^>]*>(.*?)<\/li>/gs)].map((m) => htmlText(m[1]));
      else out.dishes.push({ label: name, dish: [...value.matchAll(/<(?:p|li)[^>]*>(.*?)<\/(?:p|li)>/gs)].map((m) => htmlText(m[1])).join('; ') });
    }
    if (!out.dishes.length && !out.sides) out.note = htmlText(rest);
    return out;
  });
  if (!meals.length) throw new Error('Trough page layout changed: no meal sections found');
  return { venue: 'Pembroke servery', date, displayDate, meals };
}

function parseWestHubMenu(html, date) {
  const venue = 'West Hub canteen';
  const hours = 'Monday to Friday. Canteen 8am-2:30pm; Italian Bar 12pm-3pm; Coffee Bar 8am-4pm';
  const days = {};
  const dayRe = new RegExp(`<strong>[^<]*(${WEEKDAYS.join('|')})[^<]*</strong>\\s*</p>\\s*<ul>(.*?)</ul>`, 'gs');
  for (const [, day, list] of html.matchAll(dayRe)) {
    days[day] = [...list.matchAll(/<li[^>]*>(.*?)<\/li>/gs)].map((m) => htmlText(m[1]));
  }
  const wc = html.match(/Week commencing\s+(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})/);
  if (!wc || !Object.keys(days).length) throw new Error('West Hub page layout changed: no weekly menu found');
  const [y, m, d] = date.split('-').map(Number);
  const asked = new Date(y, m - 1, d);
  const weekday = asked.getDay();
  if (weekday === 0 || weekday === 6) return { venue, date, hours, closed: true, note: 'Closed at weekends.' };
  const weekStart = new Date(`${wc[1]} ${wc[2]} ${wc[3]}`);
  const offset = Math.round((asked - weekStart) / 86400e3);
  if (Number.isNaN(offset)) throw new Error('West Hub page layout changed: bad week date');
  const weekCommencing = `${wc[1]} ${wc[2]} ${wc[3]}`;
  if (offset < 0 || offset > 4) {
    return { venue, date, hours, weekCommencing, menuNotPublished: true, note: `Only the week commencing ${weekCommencing} is published.` };
  }
  return { venue, date, hours, weekCommencing, day: WEEKDAYS[offset], dishes: days[WEEKDAYS[offset]] || [] };
}

ipcMain.handle('lunch:menu', async (_e, args) => {
  const a = args || {};
  if (a.venue !== 'pembroke' && a.venue !== 'west_hub') throw new Error('venue must be pembroke or west_hub');
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const date = a.date == null || a.date === '' ? today : String(a.date);
  const parsed = new Date(`${date}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new Error('date must be a real YYYY-MM-DD date');
  if (Math.abs(parsed - now) > 366 * 86400e3) throw new Error('date must be within a year of today');
  return cachedRead(`lunch:${a.venue}:${date}`, async () => (a.venue === 'pembroke'
    ? parseTroughMenu(await fetchMenuPage(`${TROUGH_URL}?date=${date}`), date)
    : parseWestHubMenu(await fetchMenuPage(WEST_HUB_URL), date)));
});

app.whenReady().then(async () => {
  // Eager warm-up only — the client lazy-inits on first real use regardless.
  // Spawning the uvx child during Electron's own startup reliably trips EINTR on
  // the stdio read, so retry a few times before giving up quietly.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await initObsidianMCP();
      return;
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (attempt === 3) {
        console.error(`obsidian-mcp warm-up failed after ${attempt} attempts:`, msg);
        return;
      }
      await new Promise((r) => setTimeout(r, attempt * 1500));
    }
  }
});

app.on('will-quit', () => {
  if (obsidianClient) {
    obsidianClient.close().catch(() => {});
    obsidianClient = null;
  }
});
