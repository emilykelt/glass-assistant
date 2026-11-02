// Minimal Telegram Bot API client: long-poll for updates, send replies.
// Outbound-only — nothing listens on a port, so no tunnel or firewall change.
const POLL_TIMEOUT = 50; // seconds Telegram holds the connection open
const MAX_MESSAGE = 4096; // Telegram's hard limit per message

function endpoint(token, method) {
  return `https://api.telegram.org/bot${token}/${method}`;
}

async function call(token, method, body) {
  const res = await fetch(endpoint(token, method), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
    // Long-poll requests must outlive POLL_TIMEOUT.
    signal: AbortSignal.timeout((POLL_TIMEOUT + 15) * 1000),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`telegram ${method}: ${json.description || res.status}`);
  return json.result;
}

async function sendMessage(token, chatId, text) {
  const body = String(text || '').trim() || '(no reply)';
  for (let i = 0; i < body.length; i += MAX_MESSAGE) {
    await call(token, 'sendMessage', {
      chat_id: chatId,
      text: body.slice(i, i + MAX_MESSAGE),
    });
  }
}

// Fire-and-forget: the "typing…" indicator is cosmetic, never worth failing a turn over.
function sendTyping(token, chatId) {
  call(token, 'sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
}

// Yields one text message at a time, forever. Network blips back off and retry.
async function* pollMessages(token) {
  let offset = 0;
  let backoff = 1000;

  for (;;) {
    let updates;
    try {
      updates = await call(token, 'getUpdates', {
        offset,
        timeout: POLL_TIMEOUT,
        allowed_updates: ['message'],
      });
      backoff = 1000;
    } catch (err) {
      console.error(`[poll] ${err.message} — retrying in ${backoff / 1000}s`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60000);
      continue;
    }

    for (const update of updates) {
      offset = update.update_id + 1;
      const msg = update.message;
      if (!msg || !msg.text) continue;
      yield { chatId: msg.chat.id, text: msg.text, from: msg.from };
    }
  }
}

module.exports = { pollMessages, sendMessage, sendTyping };
