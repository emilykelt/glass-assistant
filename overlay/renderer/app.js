const MODEL = 'claude-sonnet-4-6';
const API_URL = 'https://api.anthropic.com/v1/messages';
const MAX_TOKENS = 4096;

async function buildSystemPrompt() {
  let memIndex = '(empty — bootstrap not run)';
  try {
    memIndex = await window.memory.read('memory.md');
  } catch {}
  const today = new Date().toISOString().slice(0, 10);
  return [
    `Current date: ${today}.`,
    'You are a fast, smart, general-purpose assistant living in a small floating overlay on a Mac.',
    'Help with anything: questions, lookups, code, planning, schedule, life admin.',
    '',
    'Tools you can use (call them whenever they help — do not narrate that you are about to):',
    '- `web_search` — current/factual lookups (news, docs, prices, sports, weather, anything time-sensitive or you would not reliably know).',
    '- Calendar: `get_todays_events`, `get_upcoming_events`, `create_event`.',
    '- Reminders: `get_reminders`, `create_reminder`.',
    '- Mail: `get_unread_mail`, `search_mail`, `create_mail_draft` (draft only, never sent automatically — Mail.app opens it for the user to send), `mark_mail_read` (flip a message to read using its `messageId` from `get_unread_mail`).',
    '- Anki: `anki_list_decks`, `anki_add_card`, `anki_search_cards` (requires Anki running + AnkiConnect add-on).',
    '- Weather: `get_weather` (Open-Meteo, accepts any place name).',
    '- Memory: `list_memory_files`, `read_memory`, `write_memory`, `append_memory`, `delete_memory` (see below) — this is the assistant\'s private scratchpad.',
    '- Obsidian vault: `obsidian_search`, `obsidian_list_vault`, `obsidian_list_dir`, `obsidian_get_file`, `obsidian_append`, `obsidian_patch`, `obsidian_delete`. This is the user\'s personal knowledge vault, served via the Local REST API plugin. Use it when the user asks about their own notes, refers to a topic they\'ve written about, or wants to record something durable. Paths are vault-relative (e.g. `Areas/Coursework.md`). To create a new note, use `obsidian_append` with a path that doesn\'t yet exist.',
    '- Screenshots attached by the user are a live capture of their Mac screen — treat as visual context.',
    '',
    'Long-term memory — tree of markdown files:',
    'Memory lives as a tree of `.md` files in a private directory:',
    '- `memory.md` — the curated index (shown to you below in every turn). You maintain it.',
    '- `general.md` — stable user preferences, identity, environment.',
    '- `domain/{topic}.md` — topic-specific knowledge (one file per topic).',
    '- `tools/{tool}.md` — tool configs, CLI patterns, workarounds.',
    '',
    'Rules:',
    '1. The index below is your map. Only call `read_memory` for a specific file if its description suggests it is relevant to the current question — do NOT preemptively read every file.',
    '2. When the user reveals a durable preference / fact / habit / project / deadline / taste / workaround, save it:',
    '   - General user info → `append_memory("general.md", …)`.',
    '   - New topic → `write_memory("domain/<topic>.md", …)` and also update `memory.md` to register it.',
    '   - Tool/CLI quirk → `write_memory("tools/<tool>.md", …)` and update `memory.md`.',
    '3. Prefix every new entry with `**[YYYY-MM-DD]**` (today: ' + today + ') so age can be judged.',
    '4. When you create or delete a file, also call `write_memory("memory.md", …)` to keep the index accurate (one bullet per file with a one-line purpose).',
    '5. Do not narrate memory operations — perform them silently.',
    '6. Be selective: durable facts about *the user* only. Skip trivia.',
    '',
    'Current memory index (memory.md):',
    '```',
    memIndex.trim() || '(empty)',
    '```',
    '',
    'Response style — strict:',
    '- Default to one short sentence. Treat every reply as a headline, not an article.',
    '- If the full answer would naturally run beyond ~3 lines, give a one-sentence summary and stop. Do not pre-emptively expand.',
    '- Only elaborate when the user asks ("explain", "more", "why", "details", "expand", a follow-up question). Then give just the next layer — still concise.',
    '- No preamble, recap, or sign-off. No "Sure!", "Of course", "Let me…", "Hope this helps".',
    '- Markdown is rendered: use **bold**, `code`, fenced ```code blocks```, bullet lists, and headers when they aid scanability. Prefer bullets over prose.',
    '- For schedule answers: bullets — title, time, calendar.',
    '- For factual answers: lead with the answer; cite sources only if web_search returned them.',
    '- For code: just the snippet in a fenced block; explain only if asked.',
    '- Never use emojis. No emoji in headings, bullets, status indicators, or anywhere in output.',
  ].join('\n');
}

const TOOLS = [
  {
    name: 'get_todays_events',
    description: "Get all of the user's calendar events scheduled for today.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_upcoming_events',
    description: "Get all calendar events in the next N days, starting from today.",
    input_schema: {
      type: 'object',
      properties: {
        days: {
          type: 'integer',
          description: 'Number of days ahead to look (e.g. 7 for the next week).',
          minimum: 1,
        },
      },
      required: ['days'],
    },
  },
  {
    name: 'create_event',
    description: 'Create a new calendar event in the named calendar.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        startTime: { type: 'string', description: 'ISO 8601 datetime string' },
        endTime: { type: 'string', description: 'ISO 8601 datetime string' },
        calendarName: { type: 'string', description: 'Exact name of the target Calendar' },
      },
      required: ['title', 'startTime', 'endTime', 'calendarName'],
    },
  },
  {
    name: 'get_reminders',
    description: 'Get all incomplete reminders across every list in the Reminders app.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_reminder',
    description: 'Create a new reminder in the named list. dueDate is optional.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        dueDate: { type: 'string', description: 'Optional ISO 8601 datetime' },
        listName: { type: 'string', description: 'Exact name of the Reminders list' },
      },
      required: ['title', 'listName'],
    },
  },
  {
    name: 'list_memory_files',
    description:
      'List every memory file (relative path, size, last-modified date). Use to discover what is stored when the curated index in the system prompt is insufficient.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'read_memory',
    description:
      'Read the contents of a specific memory file by relative path (e.g. "general.md", "domain/coursework.md", "tools/vim.md"). Only fetch a file when its content is likely relevant to the current question — do not load files speculatively.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path under the memory directory, ending in .md.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_memory',
    description:
      'Create or overwrite a memory file. Use to add a new topic file (under `domain/` or `tools/`) or to reorganize an existing one. Whenever you add or remove a file, also update `memory.md` to keep the index accurate. Date entries inside the file with **[YYYY-MM-DD]** prefixes.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path, ending in .md. May include a subdirectory like `domain/foo.md`.' },
        content: { type: 'string', description: 'Full markdown content of the file.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'append_memory',
    description:
      'Append a markdown block to an existing memory file (creates the file if missing). Prefix every new entry with **[YYYY-MM-DD]** so age can be judged. Preferred over `write_memory` for adding a single fact to an existing file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'delete_memory',
    description: 'Delete a memory file. Also update `memory.md` so the index stays accurate.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'get_unread_mail',
    description: 'Fetch recent unread messages from the macOS Mail inbox. Returns subject, sender, date received, and a short snippet.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max messages to return (default 10).' },
      },
      required: [],
    },
  },
  {
    name: 'search_mail',
    description: 'Search the macOS Mail inbox for messages whose subject or sender contains the query (case-insensitive substring).',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['query'],
    },
  },
  {
    name: 'create_mail_draft',
    description: 'Open a new Mail draft (visible, not auto-sent). The user reviews and sends it manually. `to` may be a single address or a comma-separated list.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address(es), comma-separated for multiple.' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['to', 'subject'],
    },
  },
  {
    name: 'mark_mail_read',
    description: 'Mark a Mail.app inbox message as read. Use the `messageId` returned by `get_unread_mail`. Returns `{matched: n}` — n is the number of inbox messages updated (0 if not found, normally 1).',
    input_schema: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: 'RFC822 Message-Id header, exactly as returned by get_unread_mail (e.g. "<abc@example.com>").' },
      },
      required: ['messageId'],
    },
  },
  {
    name: 'anki_list_decks',
    description: 'List all Anki deck names. Requires the Anki desktop app to be running with the AnkiConnect add-on (code 2055492159) installed.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'anki_add_card',
    description: 'Create a Basic flashcard (Front/Back) in the named Anki deck.',
    input_schema: {
      type: 'object',
      properties: {
        deck: { type: 'string', description: 'Exact deck name (call anki_list_decks first if unsure).' },
        front: { type: 'string', description: 'Prompt side.' },
        back: { type: 'string', description: 'Answer side.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
      },
      required: ['deck', 'front', 'back'],
    },
  },
  {
    name: 'anki_search_cards',
    description: 'Search Anki notes using Anki search syntax (e.g. "deck:Spanish tag:verb", "front:hello"). Returns up to `limit` notes.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['query'],
    },
  },
  {
    name: 'obsidian_search',
    description: 'Full-text search across the user\'s Obsidian vault. Returns matching note paths with snippets and match counts.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'obsidian_list_vault',
    description: 'List all files and directories at the root of the user\'s Obsidian vault.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'obsidian_list_dir',
    description: 'List files and directories inside a specific folder of the user\'s Obsidian vault.',
    input_schema: {
      type: 'object',
      properties: {
        dirpath: { type: 'string', description: 'Vault-relative folder path (e.g. "Areas").' },
      },
      required: ['dirpath'],
    },
  },
  {
    name: 'obsidian_get_file',
    description: 'Read the full contents of a single note in the user\'s Obsidian vault. Use `obsidian_search` or `obsidian_list_dir` first if you don\'t know the exact path.',
    input_schema: {
      type: 'object',
      properties: {
        filepath: { type: 'string', description: 'Vault-relative path to the .md file (e.g. "Areas/Coursework.md").' },
      },
      required: ['filepath'],
    },
  },
  {
    name: 'obsidian_append',
    description: 'Append content to an existing note, or create a new note if the path does not yet exist. Use this for capturing fresh thoughts into the vault.',
    input_schema: {
      type: 'object',
      properties: {
        filepath: { type: 'string', description: 'Vault-relative path (e.g. "Inbox/My Note.md").' },
        content: { type: 'string', description: 'Markdown to append (a leading blank line is recommended for separation).' },
      },
      required: ['filepath', 'content'],
    },
  },
  {
    name: 'obsidian_patch',
    description: 'Insert content surgically into an existing note, relative to a heading, block reference, or frontmatter field. Use when the user wants to add to a specific section rather than the end.',
    input_schema: {
      type: 'object',
      properties: {
        filepath: { type: 'string' },
        operation: { type: 'string', enum: ['append', 'prepend', 'replace'], description: 'How to apply the patch relative to the target.' },
        target_type: { type: 'string', enum: ['heading', 'block', 'frontmatter'] },
        target: { type: 'string', description: 'For headings, the heading text (e.g. "## Today"). For blocks, the block id. For frontmatter, the field name.' },
        content: { type: 'string' },
      },
      required: ['filepath', 'operation', 'target_type', 'target', 'content'],
    },
  },
  {
    name: 'obsidian_delete',
    description: 'Delete a file or directory in the user\'s Obsidian vault. Confirm with the user before destructive deletes of long-standing notes.',
    input_schema: {
      type: 'object',
      properties: {
        filepath: { type: 'string', description: 'Vault-relative path to delete.' },
      },
      required: ['filepath'],
    },
  },
  {
    name: 'get_weather',
    description: 'Current weather + 3-day forecast for a place. Uses Open-Meteo (no API key). WMO weather codes: 0=clear, 1-3=mostly clear→overcast, 45/48=fog, 51-57=drizzle, 61-67=rain, 71-77=snow, 80-82=rain showers, 85-86=snow showers, 95-99=thunderstorm.',
    input_schema: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'City or place name, e.g. "Cambridge UK", "Tokyo".' },
      },
      required: ['location'],
    },
  },
  {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 5,
  },
];

const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const attachStrip = document.getElementById('attachStrip');
const attachThumb = document.getElementById('attachThumb');
const attachRemove = document.getElementById('attachRemove');
const permsEl = document.getElementById('permissions');
const dismissPerms = document.getElementById('dismissPerms');
const openCalBtn = document.getElementById('openCal');
const openRemBtn = document.getElementById('openRem');
const resizerEl = document.getElementById('resizer');
const sendBtn = { disabled: false };

let pendingImage = null;

let conversation = [];
let busy = false;
let sessionId = 0;
let userResized = false;

window.api.onManualResize(() => {
  userResized = true;
});

if (!localStorage.getItem('permissionsSeen')) {
  permsEl.classList.remove('hidden');
}

const shellEl = document.getElementById('shell');

const PUCK_SIZE = 44;
let puckMode = false;
let lastExpandedSize = { width: 380, height: 200 };

function shouldShowPuck() {
  return (
    messagesEl.children.length === 0 &&
    !pendingImage &&
    !inputEl.value.trim() &&
    !busy
  );
}

function enterPuck() {
  if (puckMode) return;
  lastExpandedSize = {
    width: Math.max(220, window.outerWidth),
    height: Math.max(200, window.outerHeight),
  };
  puckMode = true;
  shellEl.classList.add('puck');
  shellEl.classList.remove('focused');
  window.api.setWindowSize(PUCK_SIZE, PUCK_SIZE);
}

function exitPuck() {
  if (!puckMode) return;
  puckMode = false;
  shellEl.classList.remove('puck');
  shellEl.classList.add('focused');
  window.api.setWindowSize(lastExpandedSize.width, lastExpandedSize.height);
  setTimeout(() => inputEl.focus(), 60);
}

function applyFocusState(focused) {
  if (focused) {
    if (puckMode) {
      exitPuck();
      return;
    }
    shellEl.classList.add('focused');
    syncWindowHeight();
  } else {
    shellEl.classList.remove('focused');
    if (shouldShowPuck()) {
      enterPuck();
    } else {
      syncWindowHeight();
    }
  }
}

window.addEventListener('focus', () => applyFocusState(true));
window.addEventListener('blur', () => applyFocusState(false));

window.addEventListener('load', () => {
  applyFocusState(document.hasFocus());
  syncWindowHeight();
});

const EXPLAIN_MODEL = 'claude-haiku-4-5-20251001';
const selectPopup = document.getElementById('selectPopup');
const selectPopupBody = document.getElementById('selectPopupBody');
let selectDebounce = null;
let selectController = null;
let selectLastText = '';

document.addEventListener('selectionchange', () => {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) {
    hideSelectPopup();
    return;
  }
  const text = sel.toString().trim();
  if (text.length < 2 || text.length > 240) {
    hideSelectPopup();
    return;
  }
  const range = sel.getRangeAt(0);
  if (!messagesEl.contains(range.commonAncestorContainer)) {
    hideSelectPopup();
    return;
  }
  if (text === selectLastText && selectPopup.classList.contains('visible')) return;

  if (selectDebounce) clearTimeout(selectDebounce);
  if (selectController) {
    selectController.abort();
    selectController = null;
  }
  selectLastText = text;
  selectDebounce = setTimeout(() => {
    positionSelectPopup(range.getBoundingClientRect());
    selectPopupBody.textContent = '';
    selectPopup.classList.add('visible', 'loading');
    streamExplain(text).catch(() => {});
  }, 350);
});

document.addEventListener('mousedown', (e) => {
  if (selectPopup.contains(e.target)) return;
  // Other clicks let selectionchange handle hide naturally
});

function hideSelectPopup() {
  if (selectDebounce) {
    clearTimeout(selectDebounce);
    selectDebounce = null;
  }
  if (selectController) {
    selectController.abort();
    selectController = null;
  }
  selectLastText = '';
  selectPopup.classList.remove('visible', 'loading');
}

function positionSelectPopup(rect) {
  selectPopup.style.left = '0px';
  selectPopup.style.top = '0px';
  selectPopup.style.maxHeight = 'none';
  const pw = selectPopup.offsetWidth || 240;
  const ph = selectPopup.offsetHeight || 60;
  const winW = window.innerWidth;
  const winH = window.innerHeight;
  let left = rect.left + rect.width / 2 - pw / 2;
  let top = rect.top - ph - 8;
  if (top < 6) top = rect.bottom + 8;
  left = Math.max(6, Math.min(winW - pw - 6, left));
  top = Math.max(6, Math.min(winH - ph - 6, top));
  selectPopup.style.left = `${left}px`;
  selectPopup.style.top = `${top}px`;
}

async function streamExplain(text) {
  selectController = new AbortController();
  const apiKey = await window.api.getApiKey();
  if (!apiKey) {
    selectPopupBody.textContent = 'No API key configured.';
    selectPopup.classList.remove('loading');
    return;
  }
  let resp;
  try {
    resp = await fetch(API_URL, {
      method: 'POST',
      signal: selectController.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: EXPLAIN_MODEL,
        max_tokens: 160,
        stream: true,
        system:
          'You explain a highlighted word or phrase. One or two short sentences, plain language. No preamble, no quoting the phrase back. If it is a proper noun give the most relevant identification first.',
        messages: [{ role: 'user', content: `Explain: "${text}"` }],
      }),
    });
  } catch (err) {
    if (err.name === 'AbortError') return;
    selectPopupBody.textContent = `Error: ${err.message || err}`;
    selectPopup.classList.remove('loading');
    return;
  }
  if (!resp.ok || !resp.body) {
    selectPopupBody.textContent = `Error: ${resp.status}`;
    selectPopup.classList.remove('loading');
    return;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let first = true;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const evt = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = evt
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n');
        if (!data || data === '[DONE]') continue;
        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }
        if (
          parsed.type === 'content_block_delta' &&
          parsed.delta &&
          parsed.delta.type === 'text_delta'
        ) {
          if (first) {
            selectPopup.classList.remove('loading');
            first = false;
          }
          selectPopupBody.textContent += parsed.delta.text;
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      selectPopupBody.textContent += `\n(stream error: ${err.message || err})`;
    }
  } finally {
    selectPopup.classList.remove('loading');
  }
}
dismissPerms.addEventListener('click', () => {
  localStorage.setItem('permissionsSeen', '1');
  permsEl.classList.add('hidden');
});
openCalBtn.addEventListener('click', () => window.api.openPrivacy('calendars'));
openRemBtn.addEventListener('click', () => window.api.openPrivacy('reminders'));

inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 110) + 'px';
});

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
});

window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    clearConversation();
  } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'i') {
    e.preventDefault();
    captureScreen();
  }
});

attachRemove.addEventListener('click', clearPendingImage);

window.addEventListener('paste', handlePaste);
inputEl.addEventListener('paste', handlePaste);

async function handlePaste(e) {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const blob = item.getAsFile();
      if (!blob) continue;
      e.preventDefault();
      const dataUrl = await blobToDataUrl(blob);
      setPendingImage(dataUrl);
      return;
    }
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function setPendingImage(dataUrl) {
  pendingImage = dataUrl;
  attachThumb.src = dataUrl;
  attachStrip.classList.remove('hidden');
  syncWindowHeight();
  inputEl.focus();
}

async function captureScreen() {
  if (busy) return;
  const dataUrl = await window.api.captureScreen();
  if (!dataUrl) {
    addErrorBubble('Screen capture failed. Grant Screen Recording in System Settings → Privacy & Security.');
    return;
  }
  setPendingImage(dataUrl);
}

function clearPendingImage() {
  pendingImage = null;
  attachThumb.removeAttribute('src');
  attachStrip.classList.add('hidden');
  syncWindowHeight();
}

resizerEl.addEventListener('mousedown', (e) => {
  e.preventDefault();
});

function clearConversation() {
  sessionId++;
  conversation = [];
  messagesEl.innerHTML = '';
  busy = false;
  sendBtn.disabled = false;
  userResized = false;
  syncWindowHeight();
}

let pendingSync = false;
function syncWindowHeight() {
  if (puckMode) return;
  if (userResized) return;
  if (pendingSync) return;
  pendingSync = true;
  requestAnimationFrame(() => {
    pendingSync = false;
    const drag = document.getElementById('dragHandle').offsetHeight;
    const composer = document.getElementById('composer').offsetHeight;
    const context = document.getElementById('contextBar').offsetHeight;
    const kids = Array.from(messagesEl.children);
    let msgsH = 0;
    if (kids.length) {
      msgsH = kids.reduce((s, el) => s + el.offsetHeight, 0);
      msgsH += (kids.length - 1) * 8;
      msgsH += 16;
    }
    const total = drag + msgsH + composer + context + 4;
    window.api.resizeToContent(total);
  });
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
    const overflowing = messagesEl.scrollHeight > messagesEl.clientHeight + 4;
    messagesEl.classList.toggle('overflowing', overflowing);
  });
}

function addUserBubble(text, imageDataUrl) {
  const b = document.createElement('div');
  b.className = 'bubble user';
  if (imageDataUrl) {
    const img = document.createElement('img');
    img.className = 'bubble-img';
    img.src = imageDataUrl;
    b.appendChild(img);
  }
  if (text) {
    const span = document.createElement('span');
    span.textContent = text;
    b.appendChild(span);
  }
  messagesEl.appendChild(b);
  syncWindowHeight();
  scrollToBottom();
}

function addAssistantBubble() {
  const b = document.createElement('div');
  b.className = 'bubble assistant';
  b._rawText = '';
  messagesEl.appendChild(b);
  syncWindowHeight();
  scrollToBottom();
  return b;
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMarkdown(text) {
  if (!text) return '';
  const fences = [];
  let body = text.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const i = fences.length;
    fences.push(
      `<pre class="md-pre"><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`
    );
    return ` F${i} `;
  });
  const inlines = [];
  body = body.replace(/`([^`\n]+)`/g, (_, code) => {
    const i = inlines.length;
    inlines.push(`<code class="md-code">${escapeHtml(code)}</code>`);
    return ` I${i} `;
  });
  body = escapeHtml(body);
  body = body.replace(
    /(?:^|\n)(\|[^\n]+\|)\n(\|[\s|:-]+\|)\n((?:\|[^\n]+\|(?:\n|$))*)/g,
    (_m, header, sep, rows) => {
      const split = (line) => line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const headerCells = split(header);
      const aligns = split(sep).map((c) => {
        const left = c.startsWith(':');
        const right = c.endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';
        if (left) return 'left';
        return null;
      });
      const align = (i) => (aligns[i] ? ` style="text-align:${aligns[i]}"` : '');
      const headerHtml =
        '<tr>' +
        headerCells.map((c, i) => `<th${align(i)}>${c}</th>`).join('') +
        '</tr>';
      const bodyHtml = rows
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((row) => {
          const cells = split(row);
          return (
            '<tr>' +
            cells.map((c, i) => `<td${align(i)}>${c}</td>`).join('') +
            '</tr>'
          );
        })
        .join('');
      return `\n<table class="md-table">${headerHtml}${bodyHtml}</table>`;
    }
  );
  body = body.replace(/^###\s+(.*)$/gm, '<h3>$1</h3>');
  body = body.replace(/^##\s+(.*)$/gm, '<h2>$1</h2>');
  body = body.replace(/^#\s+(.*)$/gm, '<h1>$1</h1>');
  body = body.replace(/(?:^|\n)((?:[-*+]\s+.+(?:\n|$))+)/g, (m, group) => {
    const items = group
      .trim()
      .split('\n')
      .map((l) => `<li>${l.replace(/^[-*+]\s+/, '')}</li>`)
      .join('');
    return '\n<ul>' + items + '</ul>';
  });
  body = body.replace(/(?:^|\n)((?:\d+\.\s+.+(?:\n|$))+)/g, (m, group) => {
    const items = group
      .trim()
      .split('\n')
      .map((l) => `<li>${l.replace(/^\d+\.\s+/, '')}</li>`)
      .join('');
    return '\n<ol>' + items + '</ol>';
  });
  body = body.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  body = body.replace(/(^|[\s>(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  body = body.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );
  body = body
    .split(/\n\n+/)
    .map((p) => {
      if (!p.trim()) return '';
      if (/^\s*<(h\d|ul|ol|pre|table)/i.test(p)) return p;
      return `<p>${p.replace(/\n/g, '<br>')}</p>`;
    })
    .join('');
  body = body.replace(/ I(\d+) /g, (_, i) => inlines[+i]);
  body = body.replace(/ F(\d+) /g, (_, i) => fences[+i]);
  return body;
}

function addToolPill(name, args) {
  const pill = document.createElement('div');
  pill.className = 'tool-pill';
  let argSummary = '';
  if (args && Object.keys(args).length) {
    argSummary = ' ' + Object.entries(args)
      .map(([k, v]) => `${k}=${typeof v === 'string' && v.length > 18 ? v.slice(0, 18) + '…' : v}`)
      .join(' ');
  }
  pill.textContent = `⚙ ${name}${argSummary}`;
  messagesEl.appendChild(pill);
  syncWindowHeight();
  scrollToBottom();
}

function addErrorBubble(text) {
  const b = document.createElement('div');
  b.className = 'bubble error';
  b.textContent = text;
  messagesEl.appendChild(b);
  syncWindowHeight();
  scrollToBottom();
}

function addTyping() {
  const t = document.createElement('div');
  t.className = 'typing';
  t.innerHTML = '<span></span><span></span><span></span>';
  messagesEl.appendChild(t);
  syncWindowHeight();
  scrollToBottom();
  return t;
}

async function submit() {
  if (busy) return;
  const text = inputEl.value.trim();
  const image = pendingImage;
  if (!text && !image) return;
  inputEl.value = '';
  inputEl.style.height = 'auto';
  addUserBubble(text, image);
  if (image) {
    const match = image.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
    const mediaType = (match && match[1]) || 'image/png';
    const base64 = match ? match[2] : image.replace(/^data:image\/\w+;base64,/, '');
    const blocks = [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
    ];
    if (text) blocks.push({ type: 'text', text });
    conversation.push({ role: 'user', content: blocks });
    clearPendingImage();
  } else {
    conversation.push({ role: 'user', content: text });
  }
  await runAgenticLoop();
}

async function runAgenticLoop() {
  const mySession = sessionId;
  busy = true;
  sendBtn.disabled = true;

  const apiKey = await window.api.getApiKey();
  if (mySession !== sessionId) return;
  if (!apiKey) {
    addErrorBubble('No ANTHROPIC_API_KEY found. Add it to overlay/.env and restart.');
    busy = false;
    sendBtn.disabled = false;
    return;
  }

  try {
    let stop = false;
    let safety = 0;
    while (!stop && safety++ < 8) {
      if (mySession !== sessionId) return;
      const typing = addTyping();
      let bubble = null;
      let assistantBlocks = [];

      try {
        sanitizeConversation();
        const systemPrompt = await buildSystemPrompt();
        const result = await streamMessage({
          apiKey,
          system: systemPrompt,
          messages: conversation,
          onTextStart: () => {
            if (mySession !== sessionId) return;
            if (typing.parentNode) typing.remove();
            bubble = addAssistantBubble();
          },
          onText: (delta) => {
            if (mySession !== sessionId) return;
            if (!bubble) {
              if (typing.parentNode) typing.remove();
              bubble = addAssistantBubble();
            }
            bubble._rawText = (bubble._rawText || '') + delta;
            bubble.innerHTML = renderMarkdown(bubble._rawText);
            syncWindowHeight();
            scrollToBottom();
          },
        });

        if (mySession !== sessionId) return;
        if (typing.parentNode) typing.remove();
        assistantBlocks = result.content;

        conversation.push({ role: 'assistant', content: assistantBlocks });

        const clientToolUses = assistantBlocks.filter((b) => b.type === 'tool_use');
        if (result.stop_reason === 'tool_use' && clientToolUses.length > 0) {
          const toolUses = clientToolUses;
          const toolResults = [];
          for (const tu of toolUses) {
            addToolPill(tu.name, tu.input);
            try {
              const res = await runTool(tu.name, tu.input || {});
              toolResults.push({
                type: 'tool_result',
                tool_use_id: tu.id,
                content: JSON.stringify(res),
              });
            } catch (err) {
              toolResults.push({
                type: 'tool_result',
                tool_use_id: tu.id,
                is_error: true,
                content: String(err && err.message ? err.message : err),
              });
            }
            if (mySession !== sessionId) return;
          }
          if (mySession !== sessionId) return;
          conversation.push({ role: 'user', content: toolResults });
        } else {
          stop = true;
        }
      } catch (err) {
        if (mySession !== sessionId) return;
        if (typing.parentNode) typing.remove();
        if (bubble && !bubble.textContent) bubble.remove();
        addErrorBubble(`Error: ${err.message || err}`);
        rollbackOrphanedToolUse();
        stop = true;
      }
    }
  } finally {
    if (mySession === sessionId) {
      busy = false;
      sendBtn.disabled = false;
      inputEl.focus();
    }
  }
}

function rollbackOrphanedToolUse() {
  while (conversation.length) {
    const last = conversation[conversation.length - 1];
    const hasOrphanToolUse =
      last.role === 'assistant' &&
      Array.isArray(last.content) &&
      last.content.some((b) => b && b.type === 'tool_use');
    const isToolResult =
      last.role === 'user' &&
      Array.isArray(last.content) &&
      last.content.some((b) => b && b.type === 'tool_result');
    if (hasOrphanToolUse || isToolResult) {
      conversation.pop();
    } else {
      break;
    }
  }
}

function sanitizeConversation() {
  for (let i = 0; i < conversation.length; i++) {
    const msg = conversation[i];
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    const next = conversation[i + 1];
    const resolvedIds =
      next && next.role === 'user' && Array.isArray(next.content)
        ? new Set(
            next.content
              .filter((b) => b && b.type === 'tool_result' && b.tool_use_id)
              .map((b) => b.tool_use_id)
          )
        : new Set();
    const cleaned = msg.content.filter(
      (b) => !b || b.type !== 'tool_use' || resolvedIds.has(b.id)
    );
    if (cleaned.length === msg.content.length) continue;
    if (cleaned.length === 0) {
      msg.content = [{ type: 'text', text: '(tool call dropped)' }];
    } else {
      msg.content = cleaned;
    }
  }
}

async function runTool(name, input) {
  const a = window.appleScripts;
  const m = window.memory;
  switch (name) {
    case 'get_todays_events':
      return await a.get_todays_events();
    case 'get_upcoming_events':
      return await a.get_upcoming_events(input.days);
    case 'create_event':
      return await a.create_event(input);
    case 'get_reminders':
      return await a.get_reminders();
    case 'create_reminder':
      return await a.create_reminder(input);
    case 'list_memory_files':
      return await m.tree();
    case 'read_memory':
      return await m.read(input.path);
    case 'write_memory':
      return await m.write(input.path, input.content);
    case 'append_memory':
      return await m.append(input.path, input.content);
    case 'delete_memory':
      return await m.delete(input.path);
    case 'get_unread_mail':
      return await window.mail.get_unread(input.limit);
    case 'search_mail':
      return await window.mail.search(input);
    case 'create_mail_draft':
      return await window.mail.create_draft(input);
    case 'mark_mail_read':
      return await window.mail.mark_read(input);
    case 'anki_list_decks':
      return await window.anki.list_decks();
    case 'anki_add_card':
      return await window.anki.add_card(input);
    case 'anki_search_cards':
      return await window.anki.search_cards(input);
    case 'get_weather':
      return await window.weather.get(input.location);
    case 'obsidian_search':
      return await window.obsidian.search(input);
    case 'obsidian_list_vault':
      return await window.obsidian.list_vault(input);
    case 'obsidian_list_dir':
      return await window.obsidian.list_dir(input);
    case 'obsidian_get_file':
      return await window.obsidian.get_file(input);
    case 'obsidian_append':
      return await window.obsidian.append(input);
    case 'obsidian_patch':
      return await window.obsidian.patch(input);
    case 'obsidian_delete':
      return await window.obsidian.delete(input);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function streamMessage({ apiKey, system, messages, onTextStart, onText }) {
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system,
    tools: TOOLS,
    stream: true,
    messages,
  };

  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok || !resp.body) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`${resp.status} ${resp.statusText}: ${errText.slice(0, 240)}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const blocks = [];
  let stop_reason = null;
  let textStarted = false;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const evt = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLines = evt
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim());
      if (!dataLines.length) continue;
      const data = dataLines.join('\n');
      if (data === '[DONE]') continue;
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      handleEvent(parsed);
    }
  }

  function handleEvent(ev) {
    if (ev.type === 'content_block_start') {
      blocks[ev.index] = { ...ev.content_block };
      const t = ev.content_block.type;
      if (t === 'tool_use' || t === 'server_tool_use') {
        blocks[ev.index]._inputJson = '';
      } else if (t === 'text') {
        blocks[ev.index].text = '';
      }
    } else if (ev.type === 'content_block_delta') {
      const block = blocks[ev.index];
      if (!block) return;
      if (ev.delta.type === 'text_delta') {
        if (!textStarted) {
          textStarted = true;
          onTextStart && onTextStart();
        }
        block.text = (block.text || '') + ev.delta.text;
        onText && onText(ev.delta.text);
      } else if (ev.delta.type === 'input_json_delta') {
        block._inputJson = (block._inputJson || '') + (ev.delta.partial_json || '');
      }
    } else if (ev.type === 'content_block_stop') {
      const block = blocks[ev.index];
      if (block && (block.type === 'tool_use' || block.type === 'server_tool_use')) {
        try {
          block.input = block._inputJson ? JSON.parse(block._inputJson) : {};
        } catch {
          block.input = {};
        }
        delete block._inputJson;
      }
    } else if (ev.type === 'message_delta') {
      if (ev.delta && ev.delta.stop_reason) stop_reason = ev.delta.stop_reason;
    } else if (ev.type === 'error') {
      throw new Error(ev.error?.message || 'stream error');
    }
  }

  const cleaned = blocks.filter(Boolean).map((b) => {
    if (b.type === 'text') return { type: 'text', text: b.text || '' };
    if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input || {} };
    if (b.type === 'server_tool_use') return { type: 'server_tool_use', id: b.id, name: b.name, input: b.input || {} };
    const { _inputJson, ...rest } = b;
    return rest;
  });

  return { content: cleaned, stop_reason };
}
