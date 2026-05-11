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
