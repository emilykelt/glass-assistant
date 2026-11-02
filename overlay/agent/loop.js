// The Claude turn: system prompt, tool-use loop, history trimming.
// Transport-agnostic on purpose — index.js wires it to Telegram.
const Anthropic = require('@anthropic-ai/sdk');
const { TOOLS, runTool, TZ } = require('./tools');

const MODEL = process.env.AGENT_MODEL || 'claude-opus-5';
const MAX_TOKENS = 16000;
const MAX_TOOL_ROUNDS = 12; // backstop against a tool loop that never converges
const MAX_HISTORY = 40; // messages retained per chat before trimming

let client;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

function systemPrompt() {
  const now = new Date();
  const longDate = now.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ,
  });
  const time = now.toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: TZ,
  });
  return [
    `Today is ${longDate}. Local time ${time} (${TZ}). ISO date ${now.toISOString().slice(0, 10)}.`,
    'Treat the date and weekday above as ground truth — never derive the weekday from the ISO date yourself.',
    '',
    "You are the user's scheduling assistant, reached over a text-message app. You can read and change",
    'their macOS Calendar and Reminders through the tools below.',
    '',
    'How to reply:',
    '- Write like a text message. No headers, no markdown emphasis, no bullet lists unless you are',
    '  listing more than three things. Two or three short sentences is usually the right length.',
    '- Never preamble. Do not say "Let me check" or "I\'ll look that up" — call the tool and answer.',
    '- After a write, confirm in one line what actually changed: "Added — Dentist, Tue 12 Aug 2pm."',
    '- Write times back in local, human form ("Thu 3pm"), never raw ISO.',
    '',
    'Acting on their behalf:',
    '- Creating an event or reminder from a clear request needs no confirmation. Do it, then confirm.',
    '- Deleting an event, or moving one they did not explicitly name, needs a yes from them first.',
    '- To change or delete an event you need its id — find it with search_events or get_upcoming_events.',
    '- If a request is ambiguous in a way that changes what you would create (which day, how long,',
    '  which calendar), ask one short question rather than guessing.',
    '- If a tool returns an error, say plainly what failed. Do not retry the same call unchanged.',
  ].join('\n');
}

// Drop the oldest exchanges, but never orphan a tool_result from its tool_use:
// resume at the next plain-text user turn.
function trimHistory(messages) {
  if (messages.length <= MAX_HISTORY) return messages;
  for (let i = messages.length - MAX_HISTORY; i < messages.length; i++) {
    if (messages[i].role === 'user' && typeof messages[i].content === 'string') {
      return messages.slice(i);
    }
  }
  return [];
}

// Mutates `history` in place so the caller keeps the full thread for the next turn.
async function respond(history, log = () => {}) {
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await getClient().messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      output_config: { effort: 'medium' },
      system: systemPrompt(),
      tools: TOOLS,
      messages: history,
    });

    if (response.stop_reason === 'refusal') return "I can't help with that one.";

    // Append the whole content array — thinking blocks must survive the round trip.
    history.push({ role: 'assistant', content: response.content });

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    if (!toolUses.length) {
      const text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (response.stop_reason === 'max_tokens') {
        return `${text}\n\n(cut off — ask me to continue)`.trim();
      }
      return text;
    }

    const results = [];
    for (const use of toolUses) {
      log(`  → ${use.name} ${JSON.stringify(use.input)}`);
      const { content, is_error } = await runTool(use.name, use.input);
      if (is_error) log(`    ! ${content}`);
      results.push({ type: 'tool_result', tool_use_id: use.id, content, is_error });
    }
    history.push({ role: 'user', content: results });
  }
  return 'I got stuck going back and forth with the calendar. Try rephrasing?';
}

module.exports = { respond, trimHistory, systemPrompt, MODEL };
