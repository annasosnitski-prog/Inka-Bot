import type { NextApiRequest, NextApiResponse } from 'next';
import { upsertClient } from '../../lib/airtable';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, info: 'inka-bot webhook alive' });
  }

  const update = req.body;
  const message = update?.message;

  if (!message) {
    console.log('No message in update:', JSON.stringify(update));
    return res.status(200).json({ ok: true });
  }

  console.log('Incoming Telegram update:', JSON.stringify(message));

  const telegramId = message.from?.id;
  const chatId = message.chat?.id;

  if (message.voice) {
    if (chatId) {
      await sendTelegramMessage(chatId, 'Я пока не умею слушать голосовые — напиши текстом.');
    }
    return res.status(200).json({ ok: true });
  }

  if (!telegramId) {
    return res.status(200).json({ ok: true });
  }

  const username = message.from?.username ?? '';
  const firstName = message.from?.first_name ?? '';
  const text = message.text ?? message.caption ?? '[клиент прислал фото без подписи]';

  try {
    const { record, isNew } = await upsertClient(
      telegramId,
      {
        username,
        name: firstName,
        last_message: text,
        updated_at: new Date().toISOString(),
      },
      { lead_status: 'new', spam_count: 0 }
    );

    console.log('Airtable upsert result:', { recordId: record.id, isNew });

    if (chatId) {
      await sendTelegramMessage(
        chatId,
        `тест шаг 2: запись ${isNew ? 'создана' : 'обновлена'} (id: ${record.id})`
      );
    }
  } catch (err) {
    console.error('Airtable error:', err);
  }

  return res.status(200).json({ ok: true });
}

async function sendTelegramMessage(chatId: number, text: string) {
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
