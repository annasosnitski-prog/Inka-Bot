// ============================================================
// INKA-BOT — регистрация меню команд в Telegram (setMyCommands)
// Разовая настройка: Telegram Bot API требует, чтобы сам идентификатор
// команды был латиницей ([a-z0-9_], 1-32 симв.) — кириллические команды
// (/закрой, /счёт...) работать как обычно продолжат (их разбирает сам
// бот по тексту), но в системное меню «/» Telegram их так не примет.
// Описания — на русском, их Telegram показывает как есть.
//
// Вызывать вручную один раз (или при добавлении новой команды) — не
// cron, не webhook. Тот же CRON_SECRET, что и у payment-reminders,
// отдельный секрет заводить не нужно.
// ============================================================

import type { NextApiRequest, NextApiResponse } from 'next';
import { timingSafeEqual } from 'crypto';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

const COMMANDS = [
  { command: 'schedule', description: 'расписание: /schedule неделя|сегодня|месяц' },
  { command: 'add', description: 'открыть слот для клиента: /add walkin 20.07 15:00-18:00' },
  { command: 'close', description: 'закрыть день/окно: /close конс 20.07 10:00-12:00' },
  { command: 'delete', description: 'удалить запись: /delete конс 20.07 [имя]' },
  { command: 'invoice', description: 'клиент: /invoice Имя (или перешли сообщение)' },
  { command: 'portrait', description: 'портрет клиента: /portrait Имя' },
];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const secret = process.env.CRON_SECRET;
  if (secret) {
    const authHeader = req.headers.authorization ?? '';
    const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!provided || !safeEqual(provided, secret)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  } else {
    console.warn('CRON_SECRET not set — setup-commands endpoint is unauthenticated');
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN not set' });
  }

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: COMMANDS }),
    });
    const data = await tgRes.json();
    if (!tgRes.ok || !data.ok) {
      return res.status(502).json({ error: 'telegram setMyCommands failed', detail: data });
    }
    return res.status(200).json({ ok: true, commands: COMMANDS.map((c) => c.command) });
  } catch (err) {
    console.error('setup-commands error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
}
