// ============================================================
// INKA-BOT — список броней и открытых слотов бота для Дневника мастера
// (обратный поток, только для чтения)
//
// По просьбе Ани: НЕ карточки клиентов, НЕ привязка, только простой
// список событий, чтобы она видела всё от бота в удобном месте и сама
// заводила клиента в Дневнике вручную. Карточку клиента бот не создаёт
// и не трогает.
//
// Три вида записей — kind:
//   'booking'    — реальная бронь с клиентом (isBotBooking).
//   'master_block' — блокировка мастера через /закрой, без клиента.
//   'open_slot'  — ещё НЕ забронированный слот (ОКНО/ВИДЕО, /добавить).
//     Раньше такие вообще не отдавали ("это не бронь, показывать как
//     запись неверно") — но мастеру важно видеть, что вообще выставлено,
//     не только что уже забронировано, для планирования. Только
//     ОКНО/ВИДЕО — [ТАТУ]/[ПРИЁМ] открытыми через бота не бывают
//     (см. lib/calendar.ts, tagsForRequest).
// Свои события из Дневника (маркер "ЗАНЯТО") не показываем обратно —
// они там и так есть.
//
// Авторизация — тот же секрет, что и у /api/diary-sync (DIARY_SYNC_SECRET),
// отдельный секрет заводить не нужно: Дневник его уже хранит.
// ============================================================

import type { NextApiRequest, NextApiResponse } from 'next';
import { timingSafeEqual } from 'crypto';
import { getSchedule, tagOf, isBotBooking, MASTER_CLOSED_MARKER } from '../../lib/calendar';

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

    const realBookings = events
      .filter((e) => isBotBooking(e.summary))
      .map((e) => ({
        id: e.id,
        tag: tagOf(e.summary),
        summary: e.summary,
        start: e.start,
        end: e.end,
        kind: e.summary.includes(MASTER_CLOSED_MARKER) ? ('master_block' as const) : ('booking' as const),
      }));

    const openSlots = events
      .filter((e) => {
        if (e.isBusy) return false;
        const tag = tagOf(e.summary);
        return tag === '[ОКНО]' || tag === '[ВИДЕО]';
      })
      .map((e) => ({
        id: e.id,
        tag: tagOf(e.summary),
        summary: e.summary,
        start: e.start,
        end: e.end,
        kind: 'open_slot' as const,
      }));

    return res.status(200).json({ ok: true, bookings: [...realBookings, ...openSlots] });
  } catch (err) {
    console.error('bot-bookings error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
}
