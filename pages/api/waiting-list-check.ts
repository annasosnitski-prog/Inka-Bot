// ============================================================
// INKA-BOT — проактивная проверка листа ожидания (ШАГ 6, доп. #2).
// Вызывается по расписанию раз в день (Vercel Cron, см. vercel.json —
// Hobby-план Vercel не даёт cron чаще раза в сутки, иначе имело бы
// смысл гонять эту проверку почаще), НЕ по сообщению клиента. Раньше
// клиент в waiting_slots/waiting_slots_pinged узнавал о свободном окне
// ТОЛЬКО если сам писал что-то ещё — тогда telegram.ts заново подтягивал
// слоты из календаря (см. lib/stateMachine.ts, п. 5b, isWaitingForSlots).
// Если клиент просто ждал молча, освободившееся окно оставалось
// непоказанным сколько угодно долго (в среднем — до следующего прогона
// этого cron, максимум сутки).
//
// Этот эндпоинт сам смотрит календарь и, если для нужного типа (тату/
// консультация) появились варианты — пишет клиенту НАПРЯМУЮ (в отличие от
// payment-reminders/warm-lead-reminders, которые пингуют мастера): это
// чисто информационный шаг, прямое выполнение уже данного клиенту обещания
// "как появится — напишу" (см. no_more_slots_waiting в responderPrompt.txt),
// без элемента давления/продажи — поэтому не требует решения Ани.
//
// Одна пара вызовов getAvailableSlots на весь прогон (по одному на каждый
// тип слота), а не по вызову на клиента — календарь общий, не персональный.
//
// Идемпотентно по построению: как только клиенту показаны слоты,
// lead_status переходит в "slots_shown" — тот же самый переход, что
// происходит в обычном (реактивном) потоке telegram.ts на шаге
// show_tattoo_slots/show_consultation_slots. Клиент выпадает из выборки
// findClientsWaitingForSlots сам по себе, без отдельного гварда.
// ============================================================

import type { NextApiRequest, NextApiResponse } from 'next';
import { timingSafeEqual } from 'crypto';
import { findClientsWaitingForSlots, updateClient } from '../../lib/airtable';
import { getAvailableSlots, formatSlotForDisplay } from '../../lib/calendar';
import type { SlotType, AvailableSlot } from '../../lib/calendar';
import { sendTelegramMessage } from '../../lib/telegramApi';
import { pickWaitingListSlotType } from '../../lib/reminderWindows';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function buildSlotsMessage(slotType: SlotType, slotsDisplay: string[]): string {
  const lines = slotsDisplay.map((s, i) => `${i + 1}. ${s}`);
  const outro =
    slotType === 'consultation'
      ? 'напиши, пожалуйста, номер варианта, какой подходит — консультация бесплатная, в переписке, около 20 минут.'
      : 'напиши, пожалуйста, номер варианта, какой подходит.';
  return `привет! появились свободные окошки, которые тебе подходят:\n\n${lines.join('\n')}\n\n${outro}`;
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
    console.warn('CRON_SECRET not set — waiting-list-check endpoint is unauthenticated');
  }

  try {
    const candidates = await findClientsWaitingForSlots();
    if (candidates.length === 0) {
      return res.status(200).json({ ok: true, checked: 0, notified: 0 });
    }

    // Один запрос к календарю на тип слота, а не на клиента — оба типа
    // параллельно, не последовательно (независимые вызовы, нет причины
    // ждать один, чтобы начать другой).
    const [tattooSlots, consultationSlots] = await Promise.all([
      getAvailableSlots('tattoo', 3).catch((err) => {
        console.error('waiting-list-check: tattoo slots lookup failed:', err);
        return [] as AvailableSlot[];
      }),
      getAvailableSlots('consultation', 3).catch((err) => {
        console.error('waiting-list-check: consultation slots lookup failed:', err);
        return [] as AvailableSlot[];
      }),
    ]);
    const slotsByType: Record<SlotType, AvailableSlot[]> = {
      tattoo: tattooSlots,
      consultation: consultationSlots,
    };

    let notified = 0;

    for (const record of candidates) {
      const f = record.fields;
      const telegramId: number | undefined = f.telegram_id;
      if (!telegramId) continue;

      const slotType = pickWaitingListSlotType(f.direct_tattoo_allowed, f.consultation_needed);
      if (!slotType) continue;

      const slots = slotsByType[slotType];
      if (!slots || slots.length === 0) continue;

      const slotsDisplay = slots.map(formatSlotForDisplay);
      const text = buildSlotsMessage(slotType, slotsDisplay);

      try {
        await sendTelegramMessage(telegramId, text);
        await updateClient(record.id, {
          lead_status: 'slots_shown',
          slot_options: slots.map((s) => s.id).join(','),
          updated_at: new Date().toISOString(),
        });
        notified++;
      } catch (sendErr) {
        console.error('waiting-list-check: failed to notify record', record.id, sendErr);
      }
    }

    return res.status(200).json({ ok: true, checked: candidates.length, notified });
  } catch (err) {
    console.error('waiting-list-check error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
}
