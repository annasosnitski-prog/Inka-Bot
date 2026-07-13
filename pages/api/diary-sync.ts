// ============================================================
// INKA-BOT — Diary sync endpoint («дверца» для Дневника мастера)
// ШАГ 1 моста Дневник → календарь → бот.
//
// Дневник мастера (отдельное браузерное приложение) при создании/
// изменении/удалении записи шлёт сюда её, а эндпоинт кладёт событие
// в ТОТ ЖЕ Google Calendar, что читает бот (getSchedule). Дальше
// "что на неделе" у бота показывает записи из Дневника автоматически.
//
// БЕЗОПАСНОСТЬ: доступ по секрету DIARY_SYNC_SECRET (заголовок
// Authorization: Bearer <secret>). Секрет знает ТОЛЬКО мастер (вставляет
// его в настройках своего Дневника) — поэтому трое других пользователей
// того же приложения писать в её календарь не могут. Ключ сервисного
// аккаунта Google остаётся на сервере и Дневнику не передаётся.
//
// Тело запроса (JSON):
//   { action: "upsert" | "delete",
//     diaryId: string,                 // стабильный id записи в Дневнике
//     type: "tattoo" | "consultation", // для upsert
//     date: "YYYY-MM-DD",              // для upsert
//     time: "HH:MM",                   // для upsert (локальное, Asia/Jerusalem)
//     durationMin?: number,            // опц., по умолчанию тату=120, конс=30
//     clientName?: string,
//     descriptor?: string }            // краткий ярлык: "большая · старый клиент · тревожник"
// ============================================================

import type { NextApiRequest, NextApiResponse } from 'next';
import { timingSafeEqual } from 'crypto';
import type { SlotType } from '../../lib/calendar';
import {
  diaryEventId,
  computeEndNaive,
  buildDiaryEventSummary,
  buildDiaryEventDescription,
  upsertDiaryEvent,
  deleteDiaryEvent,
  findDiaryConflicts,
  type ConflictInfo,
} from '../../lib/calendar';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HM = /^\d{2}:\d{2}$/;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // CORS — Дневник живёт на другом домене (браузерный запрос). Секрет,
  // а не origin, охраняет доступ, поэтому origin разрешаем любой.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const secret = process.env.DIARY_SYNC_SECRET;
  if (!secret) {
    console.error('DIARY_SYNC_SECRET not set — diary sync disabled');
    return res.status(500).json({ error: 'diary sync not configured' });
  }

  const authHeader = req.headers.authorization ?? '';
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!provided || !safeEqual(provided, secret)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const action = body.action ?? 'upsert';
  const diaryId = body.diaryId;

  if (typeof diaryId !== 'string' || !diaryId.trim()) {
    return res.status(400).json({ error: 'diaryId (non-empty string) required' });
  }

  const eventId = diaryEventId(diaryId);

  try {
    if (action === 'delete') {
      const result = await deleteDiaryEvent(eventId);
      return result.ok
        ? res.status(200).json({ ok: true, eventId })
        : res.status(502).json({ error: result.error });
    }

    if (action === 'upsert') {
      const type: SlotType | null =
        body.type === 'consultation' ? 'consultation' : body.type === 'tattoo' ? 'tattoo' : null;
      if (!type) {
        return res.status(400).json({ error: 'type must be "tattoo" or "consultation"' });
      }
      const date = body.date;
      const time = body.time;
      if (typeof date !== 'string' || !YMD.test(date)) {
        return res.status(400).json({ error: 'date must be "YYYY-MM-DD"' });
      }
      if (typeof time !== 'string' || !HM.test(time)) {
        return res.status(400).json({ error: 'time must be "HH:MM"' });
      }

      const durationMin =
        typeof body.durationMin === 'number' && body.durationMin > 0
          ? body.durationMin
          : type === 'tattoo'
          ? 120
          : 30;

      const clientName = typeof body.clientName === 'string' ? body.clientName : null;
      const descriptor = typeof body.descriptor === 'string' ? body.descriptor : null;

      const startNaive = `${date}T${time}:00`;
      const endNaive = computeEndNaive(date, time, durationMin);
      const summary = buildDiaryEventSummary(type, clientName, descriptor);
      const description = buildDiaryEventDescription(clientName, descriptor);

      const result = await upsertDiaryEvent(eventId, {
        startNaive,
        endNaive,
        summary,
        description,
      });
      if (!result.ok) {
        return res.status(502).json({ error: result.error });
      }

      // Проверка пересечений: если на это же время в календаре уже что-то
      // стоит (бронь бота, другая запись), сообщаем Дневнику — он покажет
      // предупреждение мастеру. Сама запись НЕ блокируется. Сбой проверки
      // не должен ломать успешный upsert — тогда просто без conflicts.
      let conflicts: ConflictInfo[] = [];
      if (result.resolvedStart && result.resolvedEnd) {
        try {
          conflicts = await findDiaryConflicts(eventId, result.resolvedStart, result.resolvedEnd);
        } catch (confErr) {
          console.error('diary-sync conflict check failed (non-fatal):', confErr);
        }
      }

      return res.status(200).json({ ok: true, eventId, created: result.created, conflicts });
    }

    return res.status(400).json({ error: `unknown action: ${String(action)}` });
  } catch (err) {
    console.error('diary-sync error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
}
