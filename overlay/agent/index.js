// Headless texting agent: Telegram in, Claude + EventKit tools out.
// Runs as its own process (`npm run agent`) — no Electron, no renderer.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { respond, trimHistory, MODEL } = require('./loop');
const { TZ } = require('./tools');
const { pollMessages, sendMessage, sendTyping } = require('./telegram');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED = new Set(
  (process.env.TELEGRAM_ALLOWED_CHAT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

const histories = new Map();
const queues = new Map(); // one in-flight turn per chat, so replies stay ordered

async function handle(chatId, text) {
  if (/^\/(reset|clear)\b/i.test(text)) {
    histories.delete(chatId);
    return 'Cleared — starting fresh.';
  }
  if (/^\/start\b/i.test(text)) {
    return 'Ready. Ask me about your calendar or reminders, or tell me to add something.';
  }

  const history = trimHistory(histories.get(chatId) || []);
  history.push({ role: 'user', content: text });
  histories.set(chatId, history);

  return (await respond(history, console.log)) || 'Done.';
}

function enqueue(chatId, task) {
  const next = (queues.get(chatId) || Promise.resolve()).then(task, task);
  queues.set(chatId, next.catch(() => {}));
}

async function main() {
  if (!TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not set in overlay/.env');
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set in overlay/.env');

  console.log(`Agent up — model ${MODEL}, timezone ${TZ}`);
  if (!ALLOWED.size) {
    console.log('TELEGRAM_ALLOWED_CHAT_IDS is empty: every message will be refused.');
    console.log('Text the bot once, then copy the chat id logged below into overlay/.env.');
  }

  for await (const { chatId, text, from } of pollMessages(TOKEN)) {
    if (!ALLOWED.has(String(chatId))) {
      console.log(`REFUSED chat ${chatId} (@${from?.username || '?'}): ${text.slice(0, 60)}`);
      continue;
    }

    enqueue(chatId, async () => {
      console.log(`[${chatId}] ${text}`);
      sendTyping(TOKEN, chatId);
      const keepTyping = setInterval(() => sendTyping(TOKEN, chatId), 5000);
      try {
        const reply = await handle(chatId, text);
        await sendMessage(TOKEN, chatId, reply);
        console.log(`[${chatId}] ← ${reply.slice(0, 120)}`);
      } catch (err) {
        console.error(`[${chatId}] error:`, err);
        // A failed turn can leave a dangling tool_use with no result — drop the thread.
        histories.delete(chatId);
        await sendMessage(TOKEN, chatId, `Something broke: ${err.message}`).catch(() => {});
      } finally {
        clearInterval(keepTyping);
      }
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
