// ============================================================
// INKA-BOT — ежедневная сводка мастеру по начатым, но не завершённым
// диалогам. Общее для всех мастеров (ядро); профиль задаёт только часовой
// пояс. Vercel Cron работает по UTC, поэтому в vercel.json два запуска
// (07:00 и 08:00 UTC), а здесь шлём только когда у мастера 10:00.
// ============================================================

import type { NextApiRequest, NextApiResponse } from 'next';
import { timingSafeEqual } from 'crypto';
import { getMasterTelegramId } from '../../lib/masterTelegramId';
import { getMasterProfile } from '../../lib/masters';
import { findUnfinishedDialogs } from '../../lib/airtable';
import { sendTelegramMessage } from '../../lib/telegramApi';
import { buildUnfinishedDialogsDigest, isDigestHour } from '../../lib/dailyDigest';

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
    const records = await findUnfinishedDialogs();
    const text = buildUnfinishedDialogsDigest(records, now);
    if (!text) return res.status(200).json({ ok: true, sent: false, reason: 'no unfinished dialogs' });
    if (!(await sendTelegramMessage(getMasterTelegramId(), text))) {
      throw new Error('Telegram send failed');
    }
    return res.status(200).json({ ok: true, sent: true });
  } catch (err) {
    console.error('unfinished-dialogs error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
}
