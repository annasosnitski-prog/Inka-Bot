// ============================================================
// INKA-BOT — список броней, оформленных БОТОМ, для Дневника мастера
// (обратный поток, только для чтения)
//
// По просьбе Ани: НЕ карточки клиентов, НЕ привязка, только простой
// список событий, чтобы она видела брони от бота в удобном месте
// и сама заводила клиента в Дневнике вручную. Карточку клиента бот не
// создаёт и не трогает.
//
// Раньше фильтровали по тегу (только ONLINE/WALKIN), в расчёте что
// [ТАТУ]/[КОНС] мастер всегда заводит сама в Дневнике. Но /добавить
// позволяет ей создавать открытые слоты С ЛЮБЫМ тегом через бота — и
// клиент может забронировать [ТАТУ]/[КОНС]-слот через обычный бот-флоу
// тоже. Поэтому теперь фильтр по СМЫСЛУ, не по тегу: любая занятая
// запись, которую оформил бот (isBotBooking — есть тег, есть маркер
// занятости, но это не маркер "ЗАНЯТО" из Дневника). Пустые открытые
// слоты не отдаём — это ещё не бронь, показывать как "запись" неверно.
// Свои же события из Дневника (маркер "ЗАНЯТО") не показываем обратно —
// они там и так есть.
//
// Авторизация — тот же секрет, что и у /api/diary-sync (DIARY_SYNC_SECRET),
// отдельный секрет заводить не нужно: Дневник его уже хранит.
// ============================================================

import type { NextApiRequest, NextApiResponse } from 'next';
import { timingSafeEqual } from 'crypto';
import { getSchedule, tagOf, isBotBooking } from '../../lib/calendar';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' });
  }

  const secret = process.env.DIARY_SYNC_SECRET;
  if (!secret) {
    console.error('DIARY_SYNC_SECRET not set — bot-bookings disabled');
    return res.status(500).json({ error: 'not configured' });
  }

  const authHeader = req.headers.authorization ?? '';
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!provided || !safeEqual(provided, secret)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const events = await getSchedule(30); // ближайшие 30 дней
    const bookings = events
      .filter((e) => isBotBooking(e.summary))
      .map((e) => ({ id: e.id, tag: tagOf(e.summary), summary: e.summary, start: e.start, end: e.end }));

    return res.status(200).json({ ok: true, bookings });
  } catch (err) {
    console.error('bot-bookings error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
}
