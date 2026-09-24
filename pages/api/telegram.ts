import type { NextApiRequest, NextApiResponse } from 'next';
import { upsertClient, findClientByTelegramId } from '../../lib/airtable';
import { runExtractor } from '../../lib/extractor';
import { mergeClientCard } from '../../lib/clientCardMerge';
import { getNextStep, getCardPatchForStep } from '../../lib/stateMachine';
import type { ClientCard, MessageSignals, NextStep } from '../../lib/stateMachine';
import { runResponder } from '../../lib/responder';
import { runAdmin } from '../../lib/admin';
import { appendDialogTurn, parseDialogHistory, recentDialogForModel } from '../../lib/dialogLog';
import { getAvailableSlots, bookSlot, formatSlotForDisplay } from '../../lib/calendar';
import type { SlotType, AvailableSlot } from '../../lib/calendar';
import { sendTelegramMessage, forwardTelegramMessage, pickLargestTelegramPhoto } from '../../lib/telegramApi';
import { getDepositAmount } from '../../lib/paymentConfig';

// Master's own Telegram ID — admin/test mode detection.
// Admin requests are handled by the dedicated admin module below and do not
// enter the client state machine unless /client mode was explicitly enabled.
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

  // ТОЛЬКО ЛИЧНЫЕ ЧАТЫ. Бот состоит в лог-группе (см. lib/dialogLog.ts) как
  // администратор, поэтому Telegram доставляет сюда и сообщения, написанные
  // ВНУТРИ этой группы другими участниками. Без этой проверки такое
  // сообщение раньше прогонялось через клиентский пайплайн и ответ уходил
  // ПРЯМО В ГРУППУ (в топик General) — ломая смысл группы как одностороннего
  // зеркала. Группы/супергруппы/каналы полностью игнорируем.
  if (message.chat?.type !== 'private') {
    return res.status(200).json({ ok: true });
  }

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
  const photoFileId = hasPhoto ? pickLargestTelegramPhoto(message.photo)?.file_id ?? null : null;
  const photoCaption: string | null = message.caption ?? null;
  const messageText: string | null = message.text ?? message.caption ?? null;
  const lastMessageForRecord =
    messageText ?? '[клиент прислал фото без подписи]';

  const isAdminSender = telegramId === MASTER_TELEGRAM_ID;
  const clientLabel = firstName || username || String(telegramId);

  // РЕЖИМ-ПЕРЕКЛЮЧАТЕЛЬ: команды /client и /admin.
  // Перехватываются ЗДЕСЬ, до Extractor и до основного пайплайна —
  // это не сообщение клиента, это управляющая команда. Работает
  // ТОЛЬКО для isAdminSender (привязано к telegram_id, не к тексту
  // команды) — с другого аккаунта эти слова ничего не делают и уйдут
  // в обычный Extractor как непонятный текст.
  if (isAdminSender && (messageText === '/client' || messageText === '/admin')) {
    const newMode = messageText === '/client' ? 'yes' : null;
    try {
      await upsertClient(telegramId, { force_client_mode: newMode });
      const confirmText =
        newMode === 'yes'
          ? 'окей, теперь отвечаю тебе как обычному клиенту. /admin — вернуть обратно.'
          : 'вернула админ-режим.';
      if (chatId) {
        await sendTelegramMessage(chatId, confirmText);
      }
    } catch (modeErr) {
      console.error('Mode switch failed:', modeErr);
      if (chatId) {
        await sendTelegramMessage(chatId, 'не получилось переключить режим, глянь логи.');
      }
    }
    return res.status(200).json({ ok: true });
  }

  // НЕТЕКСТОВЫЕ / НЕПОДДЕРЖИВАЕМЫЕ ТИПЫ СООБЩЕНИЙ.
  // Голосовые уже отбиты выше своим отдельным сообщением. Всё остальное
  // без текста и без фото — стикер, видео, документ, аудио, гео, контакт,
  // опрос и т.п. — Extractor разбирать не умеет, а пустой прогон пайплайна
  // тратит вызовы OpenAI и может записать в карточку "пустое" сообщение,
  // сбивая состояние. Даём единый мягкий фолбэк и выходим, как с голосом.
  // Фото без подписи сюда НЕ попадает (hasPhoto=true) — у него своя ветка
  // handle_photo_no_caption внутри пайплайна.
  //
  // Мастера (isAdminSender) НЕ отбиваем этим фолбэком — её сообщения
  // (в т.ч. пересылки без текста) должны дойти до admin-обработчика ниже.
  if (!messageText && !hasPhoto && !isAdminSender) {
    if (chatId) {
      await sendTelegramMessage(
        chatId,
        'я пока понимаю только текст и фото 🙂 опиши, пожалуйста, идею словами или пришли референс картинкой.'
      );
    }
    return res.status(200).json({ ok: true });
  }

  try {
    // 1. Найти текущую карточку клиента (если есть).
    const existing = await findClientByTelegramId(telegramId);
    const currentCard = recordToClientCard(telegramId, existing?.fields ?? {});

    // 1b. ПОСЛЕДНИЕ РЕПЛИКИ ПЕРЕПИСКИ — контекст этого хода для Extractor
    // и Responder. currentCard — агрегат фактов, а recentHistory позволяет
    // понять, на какой именно последний вопрос клиент отвечает коротким
    // "да", "нет", "ок" и т.п.
    const recentHistory = recentDialogForModel(parseDialogHistory(existing));

    // 1a. ADMIN-РЕЖИМ. Мастер, если она не переключилась в клиентский путь
    // командой /client, обрабатывается отдельным admin-модулем — БЕЗ
    // клиентского Extractor / state machine / Responder.
    if (isAdminSender && currentCard.force_client_mode !== 'yes') {
      try {
        const adminResult = await runAdmin({
          text: messageText,
          masterTelegramId: telegramId,
          photoFileId,
          forwardFromId:
            message.forward_from?.id ?? message.forward_origin?.sender_user?.id ?? null,
          forwardName:
            message.forward_from?.first_name ??
            message.forward_sender_name ??
            message.forward_origin?.sender_user?.first_name ??
            null,
        });
        if (chatId && adminResult.reply) {
          await sendTelegramMessage(chatId, adminResult.reply);
        }
      } catch (adminErr) {
        console.error('Admin handler error:', adminErr);
        if (chatId) {
          await sendTelegramMessage(chatId, 'ошибка в admin-режиме, глянь логи.');
        }
      }
      return res.status(200).json({ ok: true });
    }

    // 2. EXTRACTOR — разобрать сообщение клиента на поля и transient-сигналы.
    const extracted = await runExtractor({
      currentCard,
      messageText,
      hasPhoto,
      photoCaption,
      isAdminSender,
      recentHistory,
      photoFileId,
    });

    // 3. Слить новую карточку. mergeClientCard умеет реально сбрасывать
    // проектные поля при явной новой идее и защищает уже забронированный
    // проект от перезаписи второй татуировкой.
    const mergedCard: ClientCard = mergeClientCard(currentCard, extracted, {
      hasPhotoThisMessage: hasPhoto,
      photoHasCaption: hasPhoto && !!photoCaption,
    });

    const signals: MessageSignals = {
      is_admin_sender: isAdminSender,
      is_prompt_injection: extracted.is_prompt_injection,
      is_out_of_scope: extracted.is_out_of_scope,
      is_wrong_layout: extracted.is_wrong_layout,
      client_picked_slot_id: extracted.client_picked_slot_id,
      client_wants_other_slots: extracted.client_wants_other_slots,
      client_asks_for_more_slots: extracted.client_asks_for_more_slots,
      client_wants_to_reschedule: extracted.client_wants_to_reschedule,
      client_confirms_booking: extracted.client_confirms_booking,
      service_fit: extracted.service_fit,
      service_fit_reason: extracted.service_fit_reason,
      is_new_project_request: extracted.is_new_project_request,
      photo_purpose: extracted.photo_purpose,
    };

    // СТРАХОВКА: Extractor получает recentHistory и обычно сам верно
    // связывает короткий ответ с последним вопросом Инки, но не всегда —
    // единичный сбой распознавания на этом шаге отправляет клиента в
    // тупик (ask_wants_to_book повторяется бесконечно). Код применяет
    // fallback ТОЛЬКО когда по currentCard точно видно, что клиент стоит
    // именно на вопросе "хочешь записаться?" (цена уже показана,
    // wants_to_book ещё null) — тот же контекст, что даёт getNextStep
    // ниже, поэтому false positive на "нет" в ответ на СОВСЕМ ДРУГОЙ
    // вопрос (имя/соцсеть/что угодно) здесь исключён: тогда это условие
    // просто не выполняется. "ок"/"окей" намеренно НЕ считаются
    // согласием — это нейтральный отклик, не явное "да".
    const stuckOnWantsToBook =
      signals.client_confirms_booking === null &&
      currentCard.wants_to_book === null &&
      (!!currentCard.price_quoted || currentCard.price_explained === 'yes');

    if (stuckOnWantsToBook && messageText) {
      const lower = messageText.toLowerCase().trim();
      const yesPatterns = [
        'да', 'ага', 'хочу', 'давай', 'конечно', 'запиши', 'записывай',
        'записаться', 'хочу записаться', 'запишите', 'запишите меня',
        'можно записаться', 'хочу забронировать', 'бронируй', 'го',
        'yes', 'yep', 'sure', 'lets go',
      ];
      const noPatterns = [
        'нет', 'не', 'пока нет', 'не сейчас', 'подумаю', 'позже',
        'ещё подумаю', 'еще подумаю', 'потом', 'не надо', 'не хочу',
        'пока думаю', 'не уверен', 'пока не знаю',
      ];

      const matchesYes = yesPatterns.some(
        (p) => lower === p || lower.startsWith(p + ' ') || lower.startsWith(p + ',') || lower.startsWith(p + '!')
      );
      const matchesNo = noPatterns.some(
        (p) => lower === p || lower.startsWith(p + ' ') || lower.startsWith(p + ',')
      );

      if (matchesYes && !matchesNo) {
        signals.client_confirms_booking = 'yes';
        console.log('CODE OVERRIDE: client_confirms_booking = yes (pattern match, ask_wants_to_book context)');
      } else if (matchesNo && !matchesYes) {
        signals.client_confirms_booking = 'no';
        console.log('CODE OVERRIDE: client_confirms_booking = no (pattern match, ask_wants_to_book context)');
      }
    }

    // 4. STATE MACHINE — первый проход с тем, что уже знаем
    // (slot_options из Airtable могут быть устаревшими — сейчас
    // только определяем, в какую сторону движется диалог).
    let nextStep = getNextStep(mergedCard, signals);

    // 5. CALENDAR — подгружаем АКТУАЛЬНЫЙ список слотов только когда
    // текущий state действительно находится в слот-флоу. Раньше одного
    // routeChosen + phone было достаточно, поэтому уже забронированный
    // клиент мог зря триггерить календарь на любом follow-up сообщении.
    let liveCard = mergedCard;
    let slotsDisplay: string[] | null = null;
    let rawSlots: AvailableSlot[] | null = null;

    const hasPhone = !!mergedCard.phone;
    const routeChosen =
      mergedCard.direct_tattoo_allowed === 'yes' || mergedCard.consultation_needed === 'yes';
    const slotLookupSteps: NextStep[] = [
      'show_tattoo_slots',
      'show_consultation_slots',
      'no_more_slots_waiting',
      'waiting_slots_followup_chat',
      'slot_taken_pick_again',
      'unclear_slot_choice',
      'confirm_slot_awaiting_payment',
      'confirm_consultation_booked',
    ];
    const needsFreshSlots = routeChosen && hasPhone && slotLookupSteps.includes(nextStep);

    // Если первый проход уже валидно подтвердил бронь по списку, который
    // реально показывали клиенту, не пересчитываем подтверждение по свежему
    // top-N: настоящую проверку занятости делает bookSlot() по event id.
    const alreadyConfirmed =
      nextStep === 'confirm_slot_awaiting_payment' || nextStep === 'confirm_consultation_booked';

    if (needsFreshSlots) {
      const slotType: SlotType = mergedCard.direct_tattoo_allowed === 'yes' ? 'tattoo' : 'consultation';
      try {
        const slots = await getAvailableSlots(slotType, 3);
        liveCard = { ...mergedCard, slot_options: slots.map((s) => s.id) };
        slotsDisplay = slots.map(formatSlotForDisplay);
        rawSlots = slots;
        if (!alreadyConfirmed) {
          nextStep = getNextStep(liveCard, signals);
        }
      } catch (calErr) {
        console.error('Calendar lookup failed, falling back to no slots:', calErr);
        if (!alreadyConfirmed) {
          liveCard = { ...mergedCard, slot_options: null };
          nextStep = getNextStep(liveCard, signals);
        }
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
      const result = await bookSlot(
        signals.client_picked_slot_id,
        slotType,
        liveCard.client_name || clientLabel,
        liveCard.phone
      );

      if (!result.success) {
        console.log('Booking failed, refetching slots:', result.error);
        const freshSlots = await getAvailableSlots(slotType, 3).catch(() => []);
        liveCard = {
          ...liveCard,
          chosen_slot_id: null,
          slot_options: freshSlots.map((s) => s.id),
        };
        slotsDisplay = freshSlots.map(formatSlotForDisplay);
        nextStep = 'slot_taken_pick_again';
      } else {
        const pickedIndex = liveCard.slot_options?.indexOf(signals.client_picked_slot_id) ?? -1;
        const pickedDisplay = pickedIndex >= 0 ? slotsDisplay?.[pickedIndex] ?? null : null;
        const isTattooBooking = nextStep === 'confirm_slot_awaiting_payment';
        const pickedStartIso =
          isTattooBooking && pickedIndex >= 0 ? rawSlots?.[pickedIndex]?.start ?? null : null;
        liveCard = {
          ...liveCard,
          chosen_slot_id: signals.client_picked_slot_id,
          booked_slot_display: pickedDisplay,
          booked_slot_start_iso: pickedStartIso,
          payment_reminder_sent: null,
          booked_at: isTattooBooking ? new Date().toISOString() : liveCard.booked_at,
          payment_reminder_early_sent: isTattooBooking ? null : liveCard.payment_reminder_early_sent,
        };
      }
    }

    // 7. Патч от state machine (статусы/спам-счётчик/сброс слота) —
    // считаем по финальному nextStep, не по первому черновому.
    const patch = getCardPatchForStep(nextStep, liveCard, signals);
    const finalCard: ClientCard = { ...liveCard, ...patch };

    // 8. Сохранить в Airtable. Сбой сохранения не должен лишать клиента
    // ответа на текущий ход.
    const photosCountIncrement = hasPhoto ? 1 : 0;
    const fieldsToSave = clientCardToAirtableFields(finalCard, {
      username,
      name: firstName,
      last_message: lastMessageForRecord,
      photos_count: currentCard.photos_count + photosCountIncrement,
    });

    try {
      const { record } = await upsertClient(
        telegramId,
        fieldsToSave,
        { lead_status: finalCard.lead_status, spam_count: 0 }
      );
      console.log('Airtable saved:', { recordId: record.id, nextStep });
    } catch (saveErr) {
      console.error('Airtable save failed (non-fatal — client still gets a reply for this turn):', saveErr);
    }

    // 9. RESPONDER — написать живой ответ клиенту.
    // Для фото без текста даём responder-у хотя бы назначение изображения,
    // если Extractor его уверенно определил.
    const responderLastMessage =
      messageText ??
      (extracted.photo_purpose === 'payment_proof'
        ? '[клиент прислал подтверждение оплаты]'
        : extracted.photo_purpose === 'reference'
          ? '[клиент прислал референс по тату]'
          : hasPhoto
            ? '[клиент прислал фото без подписи]'
            : null);

    const replyText = await runResponder({
      nextStep,
      clientCard: finalCard,
      lastClientMessage: responderLastMessage,
      recentHistory,
      slotsDisplay,
    });

    // 9b. РЕКВИЗИТЫ ПРЕДОПЛАТЫ. На шаге подтверждения тату дописываем
    // реквизиты ДЕТЕРМИНИРОВАННО из env, а не через LLM.
    let finalReply = replyText;
    if (nextStep === 'confirm_slot_awaiting_payment') {
      const payBlock = buildPaymentDetailsBlock();
      if (payBlock) {
        finalReply = replyText ? `${replyText}\n\n${payBlock}` : payBlock;
      }
    }

    // 10. Отправить ответ, если он не пустой.
    if (chatId && finalReply) {
      await sendTelegramMessage(chatId, finalReply);
    }

    // 10b. ЛОГ ДИАЛОГА.
    await appendDialogTurn(existing, lastMessageForRecord, finalReply);

    // 11. ПИНГ МАСТЕРУ. Шаги, которые обещают "передала мастеру" или
    // требуют действия Ани, должны иметь реальный пинг, а не только текст.
    try {
      const notifyLabel = finalCard.client_name || clientLabel;
      const masterNote = buildMasterNotification(
        nextStep,
        notifyLabel,
        username,
        lastMessageForRecord
      );
      if (masterNote) {
        await sendTelegramMessage(MASTER_TELEGRAM_ID, masterNote);
        if (
          nextStep === 'payment_screenshot_received' &&
          chatId &&
          message.message_id
        ) {
          await forwardTelegramMessage(MASTER_TELEGRAM_ID, chatId, message.message_id);
        }
      } else if (pingOnEveryMessage()) {
        await sendTelegramMessage(
          MASTER_TELEGRAM_ID,
          buildGenericMessagePing(notifyLabel, username, lastMessageForRecord)
        );
      }
    } catch (notifyErr) {
      console.error('Master notification failed:', notifyErr);
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
    price_factors: fields.price_factors ?? null,
    price_shown: fields.price_shown ?? null,
    wants_to_book: fields.wants_to_book ?? null,
    decline_followup_asked: fields.decline_followup_asked ?? null,
    phone: fields.phone ?? null,
    client_name: fields.client_name ?? null,
    contact_channel: fields.contact_channel ?? null,
    social_link: fields.social_link ?? null,
    social_asked: fields.social_asked ?? null,
    payment_status: fields.deposit_status ?? null,
    client_type: fields.client_type ?? null,
    skin_notes: fields.skin_notes ?? null,
    spam_count: fields.spam_count ?? 0,
    chosen_slot_id: fields.chosen_slot_id ?? null,
    slot_options: parseSlotOptions(fields.slot_options),
    booked_slot_display: fields.booked_slot_display ?? null,
    booked_slot_start_iso: fields.booked_slot_start_iso ?? null,
    payment_reminder_sent: fields.payment_reminder_sent ?? null,
    booked_at: fields.booked_at ?? null,
    payment_reminder_early_sent: fields.payment_reminder_early_sent ?? null,
    reference_asked: fields.reference_asked ?? null,
    photos_count: fields.photos_count ?? 0,
    has_photo_this_message: false,
    photo_has_caption: false,
    force_client_mode: fields.force_client_mode ?? null,
    service_fit: fields.service_fit ?? null,
    second_project_flagged: fields.second_project_flagged ?? null,
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
    // name — отображаемое имя. Пока клиент сам не назвал имя, берём
    // Telegram-профиль; client_name хранится отдельно как подтверждённое.
    name: card.client_name || extra.name,
    client_name: card.client_name,
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
    price_factors: card.price_factors,
    price_shown: card.price_shown,
    wants_to_book: card.wants_to_book,
    decline_followup_asked: card.decline_followup_asked,
    phone: card.phone,
    contact_channel: card.contact_channel,
    social_link: card.social_link,
    social_asked: card.social_asked,
    deposit_status: card.payment_status,
    skin_notes: card.skin_notes,
    spam_count: card.spam_count,
    chosen_slot_id: card.chosen_slot_id,
    slot_options: card.slot_options ? card.slot_options.join(',') : '',
    booked_slot_display: card.booked_slot_display,
    booked_slot_start_iso: card.booked_slot_start_iso,
    payment_reminder_sent: card.payment_reminder_sent,
    booked_at: card.booked_at,
    payment_reminder_early_sent: card.payment_reminder_early_sent,
    reference_asked: card.reference_asked,
    photos_count: extra.photos_count,
    force_client_mode: card.force_client_mode,
    service_fit: card.service_fit,
    second_project_flagged: card.second_project_flagged,
  };
}

// Текст уведомления мастеру для шагов, где Ане нужно что-то узнать или сделать.
function buildMasterNotification(
  step: NextStep,
  clientLabel: string,
  username: string,
  lastMessage: string
): string | null {
  const who = username ? `${clientLabel} (@${username})` : clientLabel;
  switch (step) {
    case 'confirm_slot_awaiting_payment':
      return `🎨 Новая бронь ТАТУ — ${who}. Слот закреплён, клиент ждёт реквизиты для предоплаты ${getDepositAmount()}₪.`;
    case 'confirm_consultation_booked':
      return `🗓 Новая КОНСУЛЬТАЦИЯ — ${who}. Слот забронирован.`;
    case 'payment_screenshot_received':
      return `💰 ${who} прислал скрин предоплаты — проверь сумму и подтверди оплату (скрин переслан ниже).`;
    case 'new_project_after_booking':
      return `🆕 ${who} написал про вторую тату при активной записи. Текущая бронь не изменена. Новый запрос: ${lastMessage}`;
    case 'reschedule_requested_ping_master':
      return `🔄 ${who} просит перенести запись — напиши насчёт нового времени.`;
    case 'slot_change_requested_waiting':
    case 'no_more_slots_waiting':
      return `⏳ ${who} в листе ожидания — подходящих слотов сейчас нет.`;
    default:
      return null;
  }
}

function pingOnEveryMessage(): boolean {
  return process.env.PING_MASTER_ON_ALL_MESSAGES === '1';
}

function buildGenericMessagePing(clientLabel: string, username: string, messageText: string): string {
  const who = username ? `${clientLabel} (@${username})` : clientLabel;
  return `📩 ${who}: ${messageText}`;
}

// Блок реквизитов предоплаты, собранный из env-переменных.
export function buildPaymentDetailsBlock(): string | null {
  const bit = (process.env.PAYMENT_BIT ?? '').trim();
  const bank = (process.env.PAYMENT_BANK ?? '').trim();
  if (!bit && !bank) {
    console.warn('PAYMENT_BIT / PAYMENT_BANK not set — payment details block skipped');
    return null;
  }

  const lines = [`реквизиты для предоплаты ${getDepositAmount()}₪ (на выбор):`];
  if (bit) lines.push(`📱 Bit: ${bit}`);
  if (bank) lines.push(`🏦 банковский перевод: ${bank}`);
  lines.push('после оплаты пришли, пожалуйста, скрин 🙏');
  return lines.join('\n');
}
