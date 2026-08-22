// ============================================================
// INKA-BOT — напоминание мастеру про тёплого лида, который затих
// после цены (ШАГ 6, доп. #1).
// Вызывается по расписанию (Vercel Cron, см. vercel.json), НЕ по
// сообщению клиента. Проходит по клиентам, которым УЖЕ показали цену
// (price_shown = "yes"), но которые так и не ответили да/нет на
// "хочешь записаться?" (wants_to_book пусто) — и молчат достаточно
// долго (см. SILENCE_WINDOW_HOURS). Это самая частая точка потери:
// человек увидел цену, отвлёкся, а дальше воронка сама к нему не
// возвращается (ask_wants_to_book задаётся один раз).
//
// Пингует МАСТЕРА, а не клиента — по тому же принципу, что и остальные
// cron-напоминания в проекте (payment-reminders): решение, писать ли
// клиенту лично и как, остаётся за Аней, бот не давит на клиента сам.
//
// Идемпотентно: после отправки помечает warm_lead_reminder_sent = "yes".
// Специально БЕЗ сброса при повторной цене — по факту устройства
// state machine wants_to_book, однажды заполненный (yes/no), уже не
// возвращается в null, так что для одного клиента это окно наступает
// максимум один раз за всю историю переписки.
// ============================================================

import type { NextApiRequest, NextApiResponse } from 'next';
import { timingSafeEqual } from 'crypto';
import { findSilentQuotedLeads, updateClient } from '../../lib/airtable';
import { sendTelegramMessage } from '../../lib/telegramApi';

const MASTER_TELEGRAM_ID = 457343487;
const SILENCE_WINDOW_HOURS = 20;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const authHeader = req.headers.authorization ?? '';
    const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!provided || !safeEqual(provided, secret)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  } else {
    console.warn('CRON_SECRET not set — warm-lead-reminders endpoint is unauthenticated');
  }

  try {
    const candidates = await findSilentQuotedLeads();
    const now = Date.now();
    let reminded = 0;

    for (const record of candidates) {
      const f = record.fields;
      const updatedAtIso: string | undefined = f.updated_at;
      if (!updatedAtIso) continue;

      const updatedAt = new Date(updatedAtIso).getTime();
      if (isNaN(updatedAt)) continue;

      const hoursSilent = (now - updatedAt) / (1000 * 60 * 60);
      if (hoursSilent < SILENCE_WINDOW_HOURS) continue;

      const who = f.name
        ? `${f.name}${f.username ? ` (@${f.username})` : ''}`
        : f.username
        ? `@${f.username}`
        : 'клиент';
      const priceLine = f.price_quoted ? ` (цена: ${f.price_quoted}₪)` : '';

      const text = `🌙 ${who} узнал цену${priceLine} и молчит уже ~${Math.round(hoursSilent)}ч, не ответив на "хочешь записаться?" — может, стоит написать лично.`;

      try {
        await sendTelegramMessage(MASTER_TELEGRAM_ID, text);
        await updateClient(record.id, { warm_lead_reminder_sent: 'yes' });
        reminded++;
      } catch (sendErr) {
        console.error('warm-lead-reminders: failed to notify for record', record.id, sendErr);
      }
    }

    return res.status(200).json({ ok: true, checked: candidates.length, reminded });
  } catch (err) {
    console.error('warm-lead-reminders error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
}
