// ============================================================
// INKA-BOT — тонкая обёртка над Telegram Bot API.
// Вынесена из pages/api/telegram.ts, чтобы переиспользовать в других
// эндпоинтах (например pages/api/payment-reminders.ts), не импортируя
// один API-роут из другого.
// ============================================================

// Общий вызов Telegram Bot API — раньше sendMessage/forwardMessage были
// продублированы (тут и в pages/api/telegram.ts) каждый со своим fetch
// и без проверки ответа: если Telegram отклонял вызов (сообщение длиннее
// 4096 символов, бот заблокирован, битый chat_id), это проходило
// незамеченным — ни ошибки, ни строки в логах. Теперь оба идут через
// один хелпер с проверкой res.ok.
async function callTelegramApi(method: string, body: Record<string, unknown>): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN not set');
    return false;
  }
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(`Telegram ${method} failed: ${res.status} ${errText}`);
    return false;
  }
  return true;
}

export async function sendTelegramMessage(chatId: number, text: string): Promise<void> {
  await callTelegramApi('sendMessage', { chat_id: chatId, text });
}

export async function forwardTelegramMessage(
  toChatId: number,
  fromChatId: number,
  messageId: number
): Promise<void> {
  await callTelegramApi('forwardMessage', {
    chat_id: toChatId,
    from_chat_id: fromChatId,
    message_id: messageId,
  });
}
