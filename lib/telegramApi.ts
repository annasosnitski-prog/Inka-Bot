// ============================================================
// INKA-BOT — тонкая обёртка над Telegram Bot API.
// Вынесена из pages/api/telegram.ts, чтобы переиспользовать в других
// эндпоинтах (например pages/api/payment-reminders.ts), не импортируя
// один API-роут из другого.
// ============================================================

export async function sendTelegramMessage(chatId: number, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN not set');
    return;
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}
