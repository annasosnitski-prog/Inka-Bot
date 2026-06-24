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
      client_confirms_booking: extracted.client_confirms_booking,
    };

    // 4. STATE MACHINE — первый проход с тем, что уже знаем
    // (slot_options из Airtable могут быть устаревшими — сейчас
    // только определяем, в какую сторону движется диалог).
    let nextStep = getNextStep(mergedCard, signals);

    // 5. CALENDAR — если следующий шаг требует показать слоты, или
    // мы уже на этапе "слоты показаны" (клиент выбирает/уточняет) —
    // подгружаем АКТУАЛЬНЫЙ список из календаря и пересчитываем шаг
    // ещё раз с реальными данными. Это не дублирует
