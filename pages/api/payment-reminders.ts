// ============================================================
// INKA-BOT — напоминание мастеру о неоплаченной предоплате (ШАГ 6 #4)
// Вызывается по расписанию (Vercel Cron, см. vercel.json), НЕ по
// сообщению клиента. Проходит по клиентам с тату-бронью, ожидающей
// предоплаты, и если до слота осталось ≤36 часов — пингует МАСТЕРА
// (не клиента: без обратной связи на этом этапе — решение писать
// клиенту остаётся за Аней). Только брони, поставленные самой БотИнкой
// (deposit_status/booked_slot_start_iso — поля клиентской воронки;
// Дневник и ручные слоты в календаре этой логики не касаются).
//
// Идемпотентно: после отправки помечает payment_reminder_sent = "yes",
// повторный прогон cron этого клиента больше не тронет. Сбрасывается
// автоматически при следующей брони (см. telegram.ts).
// ============================================================

import type { NextApiRequest, NextApiResponse } from 'next';
import { timingSafeEqual } from 'crypto';
import { findClientsAwaitingPayment, updateClient } from '../../lib/airtable';
import { sendTelegramMessage } from '../../lib/telegramApi';
import { getDepositAmount } from '../../lib/paymentConfig';

const MASTER_TELEGRAM_ID = 457343487;
const REMINDER_WINDOW_HOURS = 36;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Vercel Cron сам добавляет заголовок Authorization: Bearer $CRON_SECRET,
  // если задать переменную окружения CRON_SECRET — так отличаем реальный
  // вызов планировщика от случайного/чужого запроса на этот URL.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const authHeader = req.headers.authorization ?? '';
    const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!provided || !safeEqual(provided, secret)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  } else {
    console.warn('CRON_SECRET not set — payment-reminders endpoint is unauthenticated');
  }

  try {
    const candidates = await findClientsAwaitingPayment();
    const now = Date.now();
    let reminded = 0;

    for (const record of candidates) {
      const f = record.fields;
      const startIso: string | undefined = f.booked_slot_start_iso;
      if (!startIso) continue;

      const start = new Date(startIso).getTime();
      if (isNaN(start)) continue;

      const hoursRemaining = (start - now) / (1000 * 60 * 60);
      // Слот ещё не наступил, но осталось не больше окна — само окно
      // достаточно широкое, чтобы не зависеть от частоты запуска cron
      // (раз в час или раз в день — сработает всё равно один раз).
      if (hoursRemaining <= 0 || hoursRemaining > REMINDER_WINDOW_HOURS) continue;

      const who = f.name
        ? `${f.name}${f.username ? ` (@${f.username})` : ''}`
        : f.username
        ? `@${f.username}`
        : 'клиент';
      const when = f.booked_slot_display ? f.booked_slot_display : startIso;

      const text = `⏰ ${who} — тату ${when}, а предоплата ${getDepositAmount()}₪ ещё не пришла (осталось ~${Math.round(hoursRemaining)}ч).`;

      try {
        await sendTelegramMessage(MASTER_TELEGRAM_ID, text);
        await updateClient(record.id, { payment_reminder_sent: 'yes' });
        reminded++;
      } catch (sendErr) {
        // Не помечаем как отправленное, если сама отправка упала — cron
        // попробует этого клиента снова на следующем прогоне.
        console.error('payment-reminders: failed to notify for record', record.id, sendErr);
      }
    }

    return res.status(200).json({ ok: true, checked: candidates.length, reminded });
  } catch (err) {
    console.error('payment-reminders error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
}
