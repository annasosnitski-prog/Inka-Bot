import type { NextApiRequest, NextApiResponse } from 'next';
import { upsertClient, findClientByTelegramId } from '../../lib/airtable';
import { runExtractor } from '../../lib/extractor';
import { getNextStep, getCardPatchForStep } from '../../lib/stateMachine';
import type { ClientCard, MessageSignals, NextStep } from '../../lib/stateMachine';
import { runResponder } from '../../lib/responder';
import { getAvailableSlots, bookSlot } from '../../lib/calendar';
import type { SlotType } from '../../lib/calendar';

// Master's own Telegram ID — admin/test mode detection.
// ЗАГЛУШКА на шаге 3-4: admin_mode сейчас просто отвечает заглушкой,
// полноценная логика admin-режима строится на шаге 7.
const MASTER_TELEGRAM_ID = 457343487;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, info: 'inka-bot webhook alive' });
  }

  const update = req.body;
  const message = update?.message;

  if (!message) {
    console.log('No message in update:', JSON.stringify(update));
    return res.status(200).json({ ok: true });
  }

  console.log('Incoming Telegram update:', JSON.stringify(message));

  const telegramId = message.from?.id;
  const chatId = message.chat?.id;

  if (message.voice) {
    if (chatId) {
      await sendTelegramMessage(chatId, 'Я пока не умею слушать голосовые — напиши текстом.');
    }
    return res.status(200).json({ ok: true });
  }

  if (!telegramId) {
    return res.status(200).json({ ok: true });
  }

  const username = message.from?.username ?? '';
  const firstName = message.from?.first_name ?? '';
  const hasPhoto = !!message.photo;
  const photoCaption: string | null = message.caption ?? null;
  const messageText: string | null = message.text ?? message.caption ?? null;
  const lastMessageForRecord =
    messageText ?? '[клиент прислал фото без подписи]';

  const isAdminSender = telegramId === MASTER_TELEGRAM_ID;
  const clientLabel = firstName || username || String(telegramId);

  try {
    // 1. Найти текущую карточку клиента (если есть).
    const existing = await findClientByTelegramId(telegramId);
    const currentCard = recordToClientCard(telegramId, existing?.fields ?? {});

    // 2. EXTRACTOR — разобрать сообщение клиента на поля.
    const extracted = await runExtractor({
      currentCard,
      messageText,
      hasPhoto,
      photoCaption,
      isAdminSender,
    });

    // 3. Слить новую карточку.
    const mergedCard: ClientCard = mergeCard(currentCard, extracted, {
      hasPhotoThisMessage: hasPhoto,
      photoHasCaption: hasPhoto && !!photoCaption,
    });

    const signals: MessageSignals = {
      is_admin_sender: isAdminSender,
      is_prompt_injection: extracted.is_prompt_injection,
      is_out_of_scope: extracted.is_out_of_scope,
      client_picked_slot_id: extracted.client_picked_slot_id,
      client_wants_other_slots: extracted.client_wants_other_slots,
      client_asks_for_more_slots: extracted.client_asks_for_more_slots,
      client_wants_to_reschedule: extracted.client_wants_to_reschedule,
    };

    // 4. STATE MACHINE — первый проход с тем, что уже знаем
    // (slot_options из Airtable могут быть устаревшими — сейчас
    // только определяем, в какую сторону движется диалог).
    let nextStep = getNextStep(mergedCard, signals);

    // 5. CALENDAR — если следующий шаг требует показать слоты, или
    // мы уже на этапе "слоты показаны" (клиент выбирает/уточняет) —
    // подгружаем АКТУАЛЬНЫЙ список из календаря и пересчитываем шаг
    // ещё раз с реальными данными. Это не дублирует логику state
    // machine — просто даёт ей правильный вход.
    let liveCard = mergedCard;

    const needsFreshSlots =
      nextStep === 'show_tattoo_slots' ||
      nextStep === 'show_consultation_slots' ||
      mergedCard.lead_status === 'slots_shown';

    if (needsFreshSlots) {
      const slotType: SlotType = mergedCard.direct_tattoo_allowed === 'yes' ? 'tattoo' : 'consultation';
      try {
        const slots = await getAvailableSlots(slotType);
        liveCard = { ...mergedCard, slot_options: slots.map((s) => s.id) };
        nextStep = getNextStep(liveCard, signals);
      } catch (calErr) {
        console.error('Calendar lookup failed, falling back to no slots:', calErr);
        liveCard = { ...mergedCard, slot_options: null };
        nextStep = getNextStep(liveCard, signals);
      }
    }

    // 6. БРОНИРОВАНИЕ — если шаг подтверждает запись, реально
    // переименовываем событие в календаре. Если бронирование не
    // удалось (слот увели секунду назад) — откатываем на повторный
    // выбор, не притворяясь, что всё прошло гладко.
    if (
      (nextStep === 'confirm_slot_awaiting_payment' || nextStep === 'confirm_consultation_booked') &&
      signals.client_picked_slot_id
    ) {
      const slotType: SlotType = nextStep === 'confirm_slot_awaiting_payment' ? 'tattoo' : 'consultation';
      const result = await bookSlot(signals.client_picked_slot_id, slotType, clientLabel);

      if (!result.success) {
        console.log('Booking failed, refetching slots:', result.error);
        // Слот увели — подгружаем свежий список и просим выбрать снова.
        const freshSlots = await getAvailableSlots(slotType).catch(() => []);
        liveCard = {
          ...liveCard,
          chosen_slot_id: null,
          slot_options: freshSlots.map((s) => s.id),
        };
        nextStep = 'slot_taken_pick_again';
      } else {
        liveCard = { ...liveCard, chosen_slot_id: signals.client_picked_slot_id };
      }
    }

    // 7. Патч от state machine (статусы/спам-счётчик/сброс слота) —
    // считаем по финальному nextStep, не по первому черновому.
    const patch = getCardPatchForStep(nextStep, liveCard);
    const finalCard: ClientCard = { ...liveCard, ...patch };

    // 8. Сохранить в Airtable.
    const photosCountIncrement = hasPhoto ? 1 : 0;
    const fieldsToSave = clientCardToAirtableFields(finalCard, {
      username,
      name: firstName,
      last_message: lastMessageForRecord,
      photos_count: currentCard.photos_count + photosCountIncrement,
    });

    const { record } = await upsertClient(
      telegramId,
      fieldsToSave,
      { lead_status: finalCard.lead_status, spam_count: 0 }
    );

    console.log('Airtable saved:', { recordId: record.id, nextStep });

    // 9. RESPONDER — написать живой ответ клиенту.
    const replyText = await runResponder({
      nextStep,
      clientCard: finalCard,
      lastClientMessage: messageText,
      manualMode: false,
    });

    // 10. Отправить ответ, если он не пустой.
    if (chatId && replyText) {
      await sendTelegramMessage(chatId, replyText);
    }
  } catch (err) {
    console.error('INKA-BOT pipeline error:', err);
  }

  return res.status(200).json({ ok: true });
}

// ----------------------------------------------------------
// ПОМОЩНИКИ: конвертация Airtable <-> ClientCard
// ----------------------------------------------------------

function recordToClientCard(
  telegramId: number,
  fields: Record<string, any>
): ClientCard {
  return {
    telegram_id: telegramId,
    intent: fields.intent ?? 'unclear',
    lead_status: fields.lead_status ?? 'new',
    category: fields.category ?? null,
    idea: fields.idea ?? null,
    size: fields.size ?? null,
    placement: fields.placement ?? null,
    first_tattoo: fields.first_tattoo ?? null,
    existing_tattoo: fields.existing_tattoo ?? null,
    direct_tattoo_allowed: fields.direct_tattoo_allowed ?? null,
    consultation_needed: fields.consultation_needed ?? null,
    active_work_time_estimate: fields.active_work_time_estimate ?? null,
    price_quoted: fields.price_quoted ?? null,
    price_explained: fields.price_explained ?? null,
    contact_preference: fields.contact_preference ?? null,
    contact_value: fields.contact_value ?? null,
    payment_status: fields.payment_status ?? null,
    client_type: fields.client_type ?? null,
    skin_notes: fields.skin_notes ?? null,
    spam_count: fields.spam_count ?? 0,
    chosen_slot_id: fields.chosen_slot_id ?? null,
    slot_options: parseSlotOptions(fields.slot_options),
    photos_count: fields.photos_count ?? 0,
    has_photo_this_message: false,
    photo_has_caption: false,
  };
}

function parseSlotOptions(raw: any): string[] | null {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw.split(',').map((s) => s.trim());
  }
  return null;
}

function mergeCard(
  current: ClientCard,
  extracted: {
    intent: ClientCard['intent'];
    idea: string | null;
    placement: string | null;
    size: string | null;
    existing_tattoo: ClientCard['existing_tattoo'];
    skin_notes: string | null;
    first_tattoo: ClientCard['first_tattoo'];
    category: ClientCard['category'];
    active_work_time_estimate: string | null;
    direct_tattoo_allowed: ClientCard['direct_tattoo_allowed'];
    consultation_needed: ClientCard['consultation_needed'];
    price_quoted: string | null;
    price_explained: ClientCard['price_explained'];
    contact_preference: ClientCard['contact_preference'];
    contact_value: string | null;
  },
  messageFlags: { hasPhotoThisMessage: boolean; photoHasCaption: boolean }
): ClientCard {
  return {
    ...current,
    intent: extracted.intent ?? current.intent,
    idea: extracted.idea ?? current.idea,
    placement: extracted.placement ?? current.placement,
    size: extracted.size ?? current.size,
    existing_tattoo: extracted.existing_tattoo ?? current.existing_tattoo,
    skin_notes: extracted.skin_notes ?? current.skin_notes,
    first_tattoo: extracted.first_tattoo ?? current.first_tattoo,
    category: extracted.category ?? current.category,
    active_work_time_estimate:
      extracted.active_work_time_estimate ?? current.active_work_time_estimate,
    direct_tattoo_allowed:
      extracted.direct_tattoo_allowed ?? current.direct_tattoo_allowed,
    consultation_needed:
      extracted.consultation_needed ?? current.consultation_needed,
    price_quoted: extracted.price_quoted ?? current.price_quoted,
    price_explained: extracted.price_explained ?? current.price_explained,
    contact_preference:
      extracted.contact_preference ?? current.contact_preference,
    contact_value: extracted.contact_value ?? current.contact_value,
    has_photo_this_message: messageFlags.hasPhotoThisMessage,
    photo_has_caption: messageFlags.photoHasCaption,
  };
}

function clientCardToAirtableFields(
  card: ClientCard,
  extra: {
    username: string;
    name: string;
    last_message: string;
    photos_count: number;
  }
): Record<string, any> {
  return {
    username: extra.username,
    name: extra.name,
    last_message: extra.last_message,
    updated_at: new Date().toISOString(),
    intent: card.intent,
    lead_status: card.lead_status,
    category: card.category,
    idea: card.idea,
    size: card.size,
    placement: card.placement,
    first_tattoo: card.first_tattoo,
    existing_tattoo: card.existing_tattoo,
    direct_tattoo_allowed: card.direct_tattoo_allowed,
    consultation_needed: card.consultation_needed,
    price_quoted: card.price_quoted,
    price_explained: card.price_explained,
    contact_preference: card.contact_preference,
    contact_value: card.contact_value,
    skin_notes: card.skin_notes,
    spam_count: card.spam_count,
    chosen_slot_id: card.chosen_slot_id,
    slot_options: card.slot_options ? card.slot_options.join(',') : '',
    photos_count: extra.photos_count,
  };
}

async function sendTelegramMessage(chatId: number, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN not set');
    return;
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}
