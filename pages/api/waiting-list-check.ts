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
// консультация/кампейн) появились варианты — пишет клиенту НАПРЯМУЮ (в
// отличие от payment-reminders/warm-lead-reminders, которые только пингуют
// мастера): это чисто информационный шаг, прямое выполнение уже данного
// клиенту обещания "как появится — напишу" (см. no_more_slots_waiting в
// responderPrompt.txt), без элемента давления/продажи — поэтому не требует
// решения Ани. Мастеру при этом всё равно уходит короткое уведомление
// постфактум (что и кому написали) — иначе Аня узнаёт об этом только если
// клиент сам расскажет.
//
// Один прогон getAvailableSlots на весь тип слота (тату/консультация/
// кампейн), а не по вызову на клиента — календарь общий, не персональный.
// Берём пул побольше (POOL_SIZE), чем нужно одному клиенту (3), потому что
// у разных клиентов разные уже отклонённые id (см. excludeIds ниже) —
// общий пул фильтруется персонально для каждого, без лишних обращений к
// Google Calendar.
//
// Идемпотентно по построению для обычной воронки: как только клиенту
// показаны слоты, lead_status переходит в "slots_shown" — тот же самый
// переход, что происходит в обычном (реактивном) потоке telegram.ts на
// шаге show_tattoo_slots/show_consultation_slots. Клиент выпадает из
// выборки findClientsWaitingForSlots сам по себе, без отдельного гварда.
// Для кампейн-клиентов та же роль у очистки slot_options (см.
// findCampaignClientsWaitingForSlots в lib/airtable.ts).
//
// НЕ предлагаем клиенту слот, который он уже отклонял (см. excludeIds):
// открытое окно в календаре общее для всех ожидающих, отказ одного не
// убирает его из пула для других — поэтому исключение персональное, не
// календарное.
// ============================================================

import { getMasterTelegramId } from '../../lib/masterTelegramId';
import type { NextApiRequest, NextApiResponse } from 'next';
import { timingSafeEqual } from 'crypto';
import {
  findClientsWaitingForSlots,
  findCampaignClientsWaitingForSlots,
  updateClient,
} from '../../lib/airtable';
import { getAvailableSlots, formatSlotForDisplay } from '../../lib/calendar';
import type { SlotType, AvailableSlot } from '../../lib/calendar';
import { sendTelegramMessage } from '../../lib/telegramApi';
import { pickWaitingListSlotType } from '../../lib/reminderWindows';
import { getCampaign } from '../../lib/campaigns';
import { parseCampaignData } from '../../lib/campaignFlow';

// Тот же ID мастера, что и в payment-reminders/warm-lead-reminders —
// сюда же уходит короткое уведомление, что бот сам написал клиенту
// (Аня иначе узнаёт об этом только если клиент ей перескажет).
// telegram_id мастера — свой для каждого деплоя (см. MASTER_NAME в lib/admin.ts
// про аналогичный параметр имени). По умолчанию — текущий деплой (Аня).
const MASTER_TELEGRAM_ID = getMasterTelegramId();

// Общий пул на тип слота (а не персональный fetch на клиента) — с запасом
// над тем, что получит один клиент (3), чтобы после персонального
// excludeIds почти всегда осталось хотя бы 3 варианта.
const POOL_SIZE = 10;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function buildSlotsMessage(slotType: SlotType | 'campaign', slotsDisplay: string[]): string {
  const lines = slotsDisplay.map((s, i) => `${i + 1}. ${s}`);
  const outro =
    slotType === 'consultation'
      ? 'напиши, пожалуйста, номер варианта, какой подходит — консультация бесплатная, в переписке, около 20 минут.'
      : 'напиши, пожалуйста, номер варианта, какой подходит.';
  return `привет! появилось свободное время, которое тебе подходит:\n\n${lines.join('\n')}\n\n${outro}`;
}

function parseIdList(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function pickFresh(pool: AvailableSlot[], excludeIds: string[], max = 3): AvailableSlot[] {
  return pool.filter((slot) => !excludeIds.includes(slot.id)).slice(0, max);
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
    const [candidates, campaignCandidates] = await Promise.all([
      findClientsWaitingForSlots(),
      findCampaignClientsWaitingForSlots(),
    ]);
    if (candidates.length === 0 && campaignCandidates.length === 0) {
      return res.status(200).json({ ok: true, checked: 0, notified: 0 });
    }

    const [tattooPool, consultationPool, campaignPool] = await Promise.all([
      getAvailableSlots('tattoo', POOL_SIZE).catch((err) => {
        console.error('waiting-list-check: tattoo slots lookup failed:', err);
        return [] as AvailableSlot[];
      }),
      getAvailableSlots('consultation', POOL_SIZE).catch((err) => {
        console.error('waiting-list-check: consultation slots lookup failed:', err);
        return [] as AvailableSlot[];
      }),
      campaignCandidates.length === 0
        ? Promise.resolve([] as AvailableSlot[])
        : getAvailableSlots('campaign', POOL_SIZE).catch((err) => {
            console.error('waiting-list-check: campaign slots lookup failed:', err);
            return [] as AvailableSlot[];
          }),
    ]);
    const poolByType: Record<SlotType, AvailableSlot[]> = {
      tattoo: tattooPool,
      consultation: consultationPool,
    };

    let notified = 0;

    const notifyMaster = (text: string) => {
      sendTelegramMessage(MASTER_TELEGRAM_ID, text).catch((masterErr) => {
        console.error('waiting-list-check: failed to notify master:', masterErr);
      });
    };

    for (const record of candidates) {
      const f = record.fields;
      const telegramId: number | undefined = f.telegram_id;
      if (!telegramId) continue;

      const slotType = pickWaitingListSlotType(f.direct_tattoo_allowed, f.consultation_needed);
      if (!slotType) continue;

      const alreadyDeclined = parseIdList(f.slot_options);
      const slots = pickFresh(poolByType[slotType], alreadyDeclined);
      if (slots.length === 0) continue;

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

        // Уведомление мастеру — чисто информационное, не блокирует и не
        // откатывает сам показ слотов клиенту (тот уже состоялся выше).
        const who = f.name
          ? `${f.name}${f.username ? ` (@${f.username})` : ''}`
          : f.username
          ? `@${f.username}`
          : 'клиент';
        notifyMaster(`🔔 Инка написала ${who} про свободное время:\n${slotsDisplay.join(', ')}`);
      } catch (sendErr) {
        console.error('waiting-list-check: failed to notify record', record.id, sendErr);
      }
    }

    for (const record of campaignCandidates) {
      const f = record.fields;
      const telegramId: number | undefined = f.telegram_id;
      if (!telegramId) continue;

      const campaign = getCampaign(f.campaign_id);
      if (!campaign || campaign.booking_mode !== 'self_book_slot') continue;

      const { collected } = parseCampaignData(f.campaign_data);
      const alreadyDeclined = parseIdList(collected?.['__declined_slot_ids']);
      const slots = pickFresh(campaignPool, alreadyDeclined);
      if (slots.length === 0) continue;

      const slotsDisplay = slots.map(formatSlotForDisplay);
      const text = buildSlotsMessage('campaign', slotsDisplay);

      try {
        await sendTelegramMessage(telegramId, text);
        await updateClient(record.id, {
          // Реюз lead_status='slots_shown', как и в campaign_show_slots
          // (lib/campaignFlow.ts) — только для порядкового выбора слота
          // Extractor'ом, сама campaign-роутинг на lead_status не смотрит.
          lead_status: 'slots_shown',
          slot_options: slots.map((s) => s.id).join(','),
          updated_at: new Date().toISOString(),
        });
        notified++;

        const who = f.name
          ? `${f.name}${f.username ? ` (@${f.username})` : ''}`
          : f.username
          ? `@${f.username}`
          : 'клиент';
        notifyMaster(
          `🔔 Инка написала ${who} про свободное время по кампании «${campaign.title}»:\n${slotsDisplay.join(', ')}`
        );
      } catch (sendErr) {
        console.error('waiting-list-check: failed to notify campaign record', record.id, sendErr);
      }
    }

    return res.status(200).json({
      ok: true,
      checked: candidates.length + campaignCandidates.length,
      notified,
    });
  } catch (err) {
    console.error('waiting-list-check error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
}
