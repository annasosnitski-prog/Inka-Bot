// ============================================================
// INKA-BOT — прямой пинг клиенту, затихшему ДО цены ("зависшие
// клиенты": поздоровался, задал пару вопросов, пропал — см. обсуждение
// в проекте). warm-lead-reminders покрывает только молчание ПОСЛЕ цены
// (price_shown=yes) — этот эндпоинт закрывает более раннюю дыру.
//
// В отличие от warm-lead-reminders (пингует только мастера) — пишет
// НАПРЯМУЮ клиенту, по тому же принципу прямого контакта, что и
// waiting-list-check: мягкий, не давящий чек-ин, без конкретики
// ("хочешь записаться?" тут рано спрашивать — цены ещё не было).
// Мастеру уходит короткое уведомление постфактум, как и везде.
//
// Идемпотентно через поле early_reminder_sent (см. findSilentEarlyLeads
// в lib/airtable.ts) — ОТДЕЛЬНОЕ от warm_lead_reminder_sent и НЕ
// lead_status, чтобы не трогать то, от чего зависит фильтр
// findSilentQuotedLeads.
// ============================================================

import type { NextApiRequest, NextApiResponse } from 'next';
import { timingSafeEqual } from 'crypto';
import { findSilentEarlyLeads, updateClient } from '../../lib/airtable';
import { sendTelegramMessage } from '../../lib/telegramApi';
import { shouldSendWarmLeadReminder } from '../../lib/reminderWindows';

const MASTER_TELEGRAM_ID = 457343487;

// Дольше, чем окно post-price напоминания (20ч) — ранний лид менее
// "горячий", торопиться с чек-ином смысла меньше.
const SILENCE_WINDOW_HOURS = 24;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

const CHECKIN_TEXT =
  'привет! заметила, что давно не было вестей с твоей стороны — ты ещё думаешь ' +
  'про тату, или было что-то, на что я не успела ответить? если актуально — ' +
  'напиши в любой момент, я на связи.';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const authHeader = req.headers.authorization ?? '';
    const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!provided || !safeEqual(provided, secret)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  } else {
    console.warn('CRON_SECRET not set — early-lead-reminder endpoint is unauthenticated');
  }

  try {
    const candidates = await findSilentEarlyLeads();
    const now = Date.now();
    let notified = 0;

    for (const record of candidates) {
      const f = record.fields;
      const telegramId: number | undefined = f.telegram_id;
      if (!telegramId) continue;

      const updatedAtIso: string | undefined = f.updated_at;
      if (!updatedAtIso) continue;
      const updatedAt = new Date(updatedAtIso).getTime();
      if (isNaN(updatedAt)) continue;

      const hoursSilent = (now - updatedAt) / (1000 * 60 * 60);
      if (!shouldSendWarmLeadReminder(hoursSilent, SILENCE_WINDOW_HOURS)) continue;

      try {
        await sendTelegramMessage(telegramId, CHECKIN_TEXT);
        await updateClient(record.id, { early_reminder_sent: 'yes' });
        notified++;

        const who = f.name
          ? `${f.name}${f.username ? ` (@${f.username})` : ''}`
          : f.username
          ? `@${f.username}`
          : 'клиент';
        sendTelegramMessage(
          MASTER_TELEGRAM_ID,
          `🌙 Инка написала ${who} — молчал(а) ~${Math.round(hoursSilent)}ч ещё до цены, спросила, актуально ли.`
        ).catch((masterErr) => {
          console.error('early-lead-reminder: failed to notify master:', masterErr);
        });
      } catch (sendErr) {
        console.error('early-lead-reminder: failed to notify record', record.id, sendErr);
      }
    }

    return res.status(200).json({ ok: true, checked: candidates.length, notified });
  } catch (err) {
    console.error('early-lead-reminder error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
}
