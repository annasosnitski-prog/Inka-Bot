// ============================================================
// INKA-BOT — ежедневные сводки мастеру: начатые, но не завершённые
// диалоги, и новые брони за сутки (два отдельных сообщения, одна
// cron-джоба). Общее для всех мастеров (ядро); профиль задаёт только
// часовой пояс. Vercel Cron работает по UTC, поэтому в vercel.json два
// запуска (07:00 и 08:00 UTC), а здесь шлём только когда у мастера 10:00.
// ============================================================

import type { NextApiRequest, NextApiResponse } from 'next';
import { timingSafeEqual } from 'crypto';
import { getMasterTelegramId } from '../../lib/masterTelegramId';
import { getMasterProfile } from '../../lib/masters';
import { findUnfinishedDialogs, findRecentBookings } from '../../lib/airtable';
import { sendTelegramMessage } from '../../lib/telegramApi';
import { buildUnfinishedDialogsDigest, buildNewBookingsDigest, isDigestHour } from '../../lib/dailyDigest';

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
    console.warn('CRON_SECRET not set — unfinished-dialogs endpoint is unauthenticated');
  }

  try {
    const now = new Date();
    if (!isDigestHour(now, getMasterProfile().timezone)) {
      return res.status(200).json({ ok: true, skipped: 'not digest hour' });
    }

    const [unfinishedRecords, bookingRecords] = await Promise.all([
      findUnfinishedDialogs(),
      findRecentBookings(),
    ]);

    const unfinishedText = buildUnfinishedDialogsDigest(unfinishedRecords, now);
    const bookingsText = buildNewBookingsDigest(bookingRecords, now);

    let unfinishedSent = false;
    let bookingsSent = false;
    if (unfinishedText) {
      if (!(await sendTelegramMessage(getMasterTelegramId(), unfinishedText))) {
        throw new Error('Telegram send failed (unfinished dialogs)');
      }
      unfinishedSent = true;
    }
    if (bookingsText) {
      if (!(await sendTelegramMessage(getMasterTelegramId(), bookingsText))) {
        throw new Error('Telegram send failed (new bookings)');
      }
      bookingsSent = true;
    }

    return res.status(200).json({ ok: true, unfinishedSent, bookingsSent });
  } catch (err) {
    console.error('unfinished-dialogs error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
}
