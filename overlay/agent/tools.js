// Tool schemas + dispatcher for the texting agent.
// Every tool bottoms out in the ekhelper binary; nothing here touches AppleScript.
const { ek } = require('./ek');

const DEFAULT_CALENDAR = process.env.DEFAULT_CALENDAR || '';
const DEFAULT_REMINDER_LIST = process.env.DEFAULT_REMINDER_LIST || '';

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

// The helper's parseISO needs an explicit zone. Accept bare local datetimes
// ("2026-08-09T14:00") too, since that is what a model writes most of the time.
function normalizeISO(value, field) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return '';
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(s)) return s;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) throw new Error(`${field} must be an ISO datetime like 2026-08-09T14:00, got "${s}"`);
  const d = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4] || '00'}`);
  if (isNaN(d.getTime())) throw new Error(`${field} is not a real date: "${s}"`);
  return d.toISOString();
}

// Give the model a pre-formatted local string so it never does timezone math.
function local(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', timeZone: TZ,
  });
}

const shapeEvent = (e) => ({
  id: e.id,
  title: e.title,
  when: local(e.startTime),
  ends: local(e.endTime),
  startTime: e.startTime,
  calendar: e.calendar,
});

const shapeReminder = (r) => ({
  id: r.id,
  title: r.title,
  due: r.dueDate ? local(r.dueDate) : null,
  list: r.list,
});

async function resolveCalendar(name) {
  const picked = (name || DEFAULT_CALENDAR || '').trim();
  if (picked) return picked;
  const { calendars } = await ek(['calendars']);
  throw new Error(
    `calendarName is required (no DEFAULT_CALENDAR set). Available: ${calendars.join(', ')}`
  );
}

async function resolveList(name) {
  const picked = (name || DEFAULT_REMINDER_LIST || '').trim();
  if (picked) return picked;
  const { lists } = await ek(['calendars']);
  throw new Error(
    `listName is required (no DEFAULT_REMINDER_LIST set). Available: ${lists.join(', ')}`
  );
}

const TOOLS = [
  {
    name: 'list_calendars',
    description:
      'List the available Calendar names and Reminders list names. Call this when you need a valid ' +
      'calendarName or listName and none was supplied, or when the user refers to a calendar by a name ' +
      'you have not seen before.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_todays_events',
    description: "Get every calendar event for the rest of today, across all calendars.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_upcoming_events',
    description:
      'Get calendar events for the next N days, across all calendars. Use this for "this week", ' +
      '"tomorrow", "what am I doing on Friday" — then filter the result yourself.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'How many days ahead to look. Default 7, max 90.' },
      },
      required: [],
    },
  },
  {
    name: 'search_events',
    description:
      'Find upcoming events whose title, location, or notes contain a substring. Use this when the ' +
      'user names a specific event ("move my dentist appointment") and you need its id.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive substring to match.' },
        days: { type: 'integer', description: 'How many days ahead to search. Default 30.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'create_event',
    description: 'Create a new calendar event.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        startTime: { type: 'string', description: 'Local ISO datetime, e.g. 2026-08-09T14:00' },
        endTime: { type: 'string', description: 'Local ISO datetime. Must be after startTime.' },
        calendarName: {
          type: 'string',
          description: 'Calendar to add it to. Omit to use the configured default.',
        },
      },
      required: ['title', 'startTime', 'endTime'],
    },
  },
  {
    name: 'update_event',
    description:
      'Reschedule or rename an existing event. Get the eventId from search_events or ' +
      'get_upcoming_events first. Omit any field you are not changing.',
    input_schema: {
      type: 'object',
      properties: {
        eventId: { type: 'string' },
        startTime: { type: 'string', description: 'New local ISO start, or omit to keep.' },
        endTime: { type: 'string', description: 'New local ISO end, or omit to keep.' },
        title: { type: 'string', description: 'New title, or omit to keep.' },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'delete_event',
    description:
      'Delete a calendar event by id. Destructive — confirm with the user before calling this ' +
      'unless they clearly asked for the deletion in their message.',
    input_schema: {
      type: 'object',
      properties: { eventId: { type: 'string' } },
      required: ['eventId'],
    },
  },
  {
    name: 'get_reminders',
    description: 'Get every incomplete reminder across all Reminders lists.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_reminder',
    description: 'Add a reminder to a Reminders list.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        dueDate: { type: 'string', description: 'Local ISO datetime, or omit for no due date.' },
        listName: { type: 'string', description: 'Omit to use the configured default list.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'complete_reminder',
    description:
      'Mark an incomplete reminder as done. Pass the id if you have it, otherwise the title — ' +
      'the match is exact-id, then exact-title, then substring, and it errors if ambiguous.',
    input_schema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Reminder id, or its title.' },
      },
      required: ['target'],
    },
  },
];

const HANDLERS = {
  list_calendars: () => ek(['calendars']),

  get_todays_events: async () => (await ek(['today'])).map(shapeEvent),

  get_upcoming_events: async ({ days }) => {
    const n = Math.min(Math.max(parseInt(days, 10) || 7, 1), 90);
    return (await ek(['upcoming', String(n)])).map(shapeEvent);
  },

  search_events: async ({ query, days }) => {
    const n = Math.min(Math.max(parseInt(days, 10) || 30, 1), 365);
    return (await ek(['search-events', String(query), String(n)])).map(shapeEvent);
  },

  create_event: async ({ title, startTime, endTime, calendarName }) => {
    const start = normalizeISO(startTime, 'startTime');
    const end = normalizeISO(endTime, 'endTime');
    if (!start || !end) throw new Error('create_event needs both startTime and endTime');
    if (new Date(end) <= new Date(start)) throw new Error('endTime must be after startTime');
    const cal = await resolveCalendar(calendarName);
    return ek(['create-event', String(title), start, end, cal]);
  },

  update_event: async ({ eventId, startTime, endTime, title }) => {
    if (!eventId) throw new Error('update_event needs an eventId');
    return ek([
      'update-event',
      String(eventId),
      normalizeISO(startTime, 'startTime'),
      normalizeISO(endTime, 'endTime'),
      title ? String(title) : '',
    ]);
  },

  delete_event: async ({ eventId }) => {
    if (!eventId) throw new Error('delete_event needs an eventId');
    return ek(['delete-event', String(eventId)]);
  },

  get_reminders: async () => (await ek(['reminders'])).map(shapeReminder),

  create_reminder: async ({ title, dueDate, listName }) => {
    const list = await resolveList(listName);
    return ek(['create-reminder', String(title), normalizeISO(dueDate, 'dueDate'), list]);
  },

  complete_reminder: ({ target }) => {
    if (!target) throw new Error('complete_reminder needs a target');
    return ek(['complete-reminder', String(target)]);
  },
};

// Returns { content, is_error } ready to drop into a tool_result block.
async function runTool(name, input) {
  const handler = HANDLERS[name];
  if (!handler) return { content: `No such tool: ${name}`, is_error: true };
  try {
    const result = await handler(input || {});
    return { content: JSON.stringify(result ?? { ok: true }), is_error: false };
  } catch (err) {
    return { content: String(err.message || err), is_error: true };
  }
}

module.exports = { TOOLS, runTool, TZ };
