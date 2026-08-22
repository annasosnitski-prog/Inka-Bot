// ============================================================
// INKA-BOT — напоминания мастеру о неоплаченной предоплате (ШАГ 6 #4 + доп.)
// Вызывается по расписанию (Vercel Cron, см. vercel.json), НЕ по
// сообщению клиента. Два независимых окна, каждое со своим гвардом:
//
//   1. ПОЗДНЕЕ (исходное) — до слота осталось ≤36 часов, оплаты всё ещё
//      нет. Гвард: payment_reminder_sent.
//   2. РАННЕЕ (доп.) — с момента брони прошло ≥EARLY_WINDOW_HOURS, оплаты
//      всё ещё нет, а до слота ЕЩЁ ДАЛЕКО (> REMINDER_WINDOW_HOURS —
//      иначе это уже зона позднего окна, не дублируем). Ловит случай,
//      когда клиент забронировал тату на две недели вперёд и мог просто
//      забыть про предоплату — раньше первое напоминание приходило
//      только за 36ч до слота. Гвард: payment_reminder_early_sent.
//
// Оба пингуют МАСТЕРА, не клиента — по тому же принципу, что и раньше:
// без обратной связи на этом этапе, решение писать клиенту остаётся за
// Аней. Только брони, поставленные самой БотИнкой (deposit_status/
// booked_slot_start_iso/booked_at — поля клиентской воронки; Дневник и
// ручные слоты в календаре этой логики не касаются).
//
// Идемпотентно: после отправки помечает соответствующий гвард = "yes",
// повторный прогон cron этого клиента больше не тронет. Оба гварда
// сбрасываются автоматически при следующей брони (см. telegram.ts).
// ============================================================

import type { NextApiRequest, NextApiResponse } from 'next';
import { timingSafeEqual } from 'crypto';
import {
  findClientsAwaitingPayment,
  findClientsAwaitingPaymentEarly,
  updateClient,
} from '../../lib/airtable';
import { sendTelegramMessage } from '../../lib/telegramApi';
import { getDepositAmount } from '../../lib/paymentConfig';

const MASTER_TELEGRAM_ID = 457343487;
const REMINDER_WINDOW_HOURS = 36;
const EARLY_WINDOW_HOURS = 24;

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

    // РАННЕЕ ОКНО — независимый второй проход, свой список кандидатов и
    // свой гвард (payment_reminder_early_sent), см. заголовок файла.
    const earlyCandidates = await findClientsAwaitingPaymentEarly();
    let remindedEarly = 0;

    for (const record of earlyCandidates) {
      const f = record.fields;
      const bookedAtIso: string | undefined = f.booked_at;
      if (!bookedAtIso) continue;

      const bookedAt = new Date(bookedAtIso).getTime();
      if (isNaN(bookedAt)) continue;

      const hoursSinceBooked = (now - bookedAt) / (1000 * 60 * 60);
      if (hoursSinceBooked < EARLY_WINDOW_HOURS) continue;

      // Если до слота уже осталось ≤36ч — это зона позднего окна выше,
      // не дублируем один и тот же пинг мастеру дважды за один прогон.
      const startIso: string | undefined = f.booked_slot_start_iso;
      if (startIso) {
        const start = new Date(startIso).getTime();
        if (!isNaN(start)) {
          const hoursRemaining = (start - now) / (1000 * 60 * 60);
          if (hoursRemaining <= REMINDER_WINDOW_HOURS) continue;
        }
      }

      const who = f.name
        ? `${f.name}${f.username ? ` (@${f.username})` : ''}`
        : f.username
        ? `@${f.username}`
        : 'клиент';
      const when = f.booked_slot_display ? f.booked_slot_display : startIso ?? '';

      const text = `💤 ${who} — тату ${when}, бронь стоит уже больше суток, а предоплата ${getDepositAmount()}₪ ещё не пришла.`;

      try {
        await sendTelegramMessage(MASTER_TELEGRAM_ID, text);
        await updateClient(record.id, { payment_reminder_early_sent: 'yes' });
        remindedEarly++;
      } catch (sendErr) {
        console.error('payment-reminders: failed to send early notify for record', record.id, sendErr);
      }
    }

    return res.status(200).json({
      ok: true,
      checked: candidates.length,
      reminded,
      checkedEarly: earlyCandidates.length,
      remindedEarly,
    });
  } catch (err) {
    console.error('payment-reminders error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
}
