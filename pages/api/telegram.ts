import type { NextApiRequest, NextApiResponse } from 'next';
import { upsertClient, findClientByTelegramId } from '../../lib/airtable';
import { runExtractor } from '../../lib/extractor';
import { getNextStep, getCardPatchForStep } from '../../lib/stateMachine';
import type { ClientCard, MessageSignals, NextStep } from '../../lib/stateMachine';
import { runResponder } from '../../lib/responder';
import { runAdmin } from '../../lib/admin';
import { getAvailableSlots, bookSlot, formatSlotForDisplay } from '../../lib/calendar';
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

    // 1a. ADMIN-РЕЖИМ (ШАГ 7). Мастер (isAdminSender), если она не
    // переключилась в клиентский путь командой /client (force_client_mode),
    // обрабатывается отдельным admin-модулем — БЕЗ клиентского Extractor /
    // state machine / Responder. Иначе прогон Аниных служебных запросов
    // через воронку засоряет её же карточку и выдаёт бессмыслицу.
    if (isAdminSender && currentCard.force_client_mode !== 'yes') {
      try {
        const adminResult = await runAdmin({
          text: messageText,
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

    // ФИКС: Extractor не знает, какой шаг был предыдущим (он не получает
    // previous_step и не видит ответ бота). Поэтому он не может надёжно
    // распознать "записаться" / "да" / "хочу" как ответ на вопрос
    // "хочешь записаться?". Детерминированный перехват: если карточка
    // стоит на ask_wants_to_book (wants_to_book ещё null, цена дана)
    // и Extractor вернул client_confirms_booking = null — проверяем
    // текст сообщения на явные маркеры согласия/отказа КОДОМ.
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
        'ок', 'окей', 'ok', 'yes', 'yep', 'sure', 'lets go',
      ];
      const noPatterns = [
        'нет', 'не', 'пока нет', 'не сейчас', 'подумаю', 'позже',
        'ещё подумаю', 'еще подумаю', 'потом', 'не надо', 'не хочу',
        'пока думаю', 'не уверен', 'пока не знаю',
      ];

      // Проверяем: точное совпадение ИЛИ текст начинается с паттерна
      const matchesYes = yesPatterns.some(
        (p) => lower === p || lower.startsWith(p + ' ') || lower.startsWith(p + ',') || lower.startsWith(p + '!')
      );
      const matchesNo = noPatterns.some(
        (p) => lower === p || lower.startsWith(p + ' ') || lower.startsWith(p + ',')
      );

      if (matchesYes && !matchesNo) {
        signals.client_confirms_booking = 'yes';
        console.log('CODE OVERRIDE: client_confirms_booking = yes (pattern match)');
      } else if (matchesNo && !matchesYes) {
        signals.client_confirms_booking = 'no';
        console.log('CODE OVERRIDE: client_confirms_booking = no (pattern match)');
      }
    }

    // 4. STATE MACHINE — первый проход с тем, что уже знаем
    // (slot_options из Airtable могут быть устаревшими — сейчас
    // только определяем, в какую сторону движется диалог).
    let nextStep = getNextStep(mergedCard, signals);

    // 5. CALENDAR — подгружаем АКТУАЛЬНЫЙ список слотов из календаря,
    // если карточка УЖЕ дошла до точки, где слоты в принципе нужны:
    // направление выбрано (direct_tattoo_allowed ИЛИ consultation_needed
    // = "yes") И контакт уже известен. Это шире, чем просто проверка
    // nextStep === 'show_*' — потому что если контакт стал известен
    // ИМЕННО в этом сообщении (клиент только что ответил "в телеграм"),
    // первый проход getNextStep() ещё видит старые пустые slot_options
    // из Airtable и сразу решает "слотов нет" (no_more_slots_waiting),
    // не успев их подгрузить. Проверяем по структуре карточки, а не по
    // конкретному значению nextStep — иначе теряем именно тот момент,
    // когда слоты нужны СРАЗУ на этом же сообщении.
    let liveCard = mergedCard;
    // Человекочитаемые версии slot_options для показа клиенту через
    // Responder (Extractor и bookSlot продолжают работать с чистыми
    // event.id в slot_options — эта строка только для текста ответа).
    let slotsDisplay: string[] | null = null;

    // Слоты подгружаем, когда направление выбрано И у нас уже есть
    // телефон клиента (по бизнес-правилу телефон обязателен перед
    // показом дат — см. ask_phone в state machine). Раньше здесь был
    // гейт по contact_preference; теперь единый гейт — телефон.
    const hasPhone = !!mergedCard.phone;
    const routeChosen =
      mergedCard.direct_tattoo_allowed === 'yes' || mergedCard.consultation_needed === 'yes';
    const needsFreshSlots = routeChosen && hasPhone;

    if (needsFreshSlots) {
      const slotType: SlotType = mergedCard.direct_tattoo_allowed === 'yes' ? 'tattoo' : 'consultation';
      try {
        const slots = await getAvailableSlots(slotType);
        liveCard = { ...mergedCard, slot_options: slots.map((s) => s.id) };
        slotsDisplay = slots.map(formatSlotForDisplay);
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
        slotsDisplay = freshSlots.map(formatSlotForDisplay);
        nextStep = 'slot_taken_pick_again';
      } else {
        liveCard = { ...liveCard, chosen_slot_id: signals.client_picked_slot_id };
      }
    }

    // 7. Патч от state machine (статусы/спам-счётчик/сброс слота) —
    // считаем по финальному nextStep, не по первому черновому.
    const patch = getCardPatchForStep(nextStep, liveCard, signals);
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
      slotsDisplay,
    });

    // 9b. РЕКВИЗИТЫ ПРЕДОПЛАТЫ. На шаге подтверждения тату дописываем
    // реквизиты (Bit + банковский счёт) ДЕТЕРМИНИРОВАННО из env, а не
    // через LLM — номера нельзя доверять генерации, любая ошибка в
    // цифре = потерянные деньги. Responder-у велено НЕ печатать
    // реквизиты самому (см. confirm_slot_awaiting_payment в промпте).
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

    // 11. ПИНГ МАСТЕРУ. Некоторые шаги обещают клиенту "передала мастеру"
    // или требуют действия Ани (подтвердить оплату, назначить перенос,
    // подобрать слот). Раньше эти обещания уходили в пустоту — здесь
    // реально уведомляем мастера в её личный чат. Не пингуем, когда сама
    // Аня тестирует клиентский путь (isAdminSender) — иначе спам себе же.
    // Обёрнуто в свой try/catch: сбой пинга не должен ломать ответ клиенту.
    if (!isAdminSender) {
      try {
        const masterNote = buildMasterNotification(nextStep, clientLabel, username);
        if (masterNote) {
          await sendTelegramMessage(MASTER_TELEGRAM_ID, masterNote);
          // Скрин оплаты пересылаем Ане целиком — ей нужно видеть саму
          // картинку, чтобы сверить сумму и подтвердить.
          if (
            nextStep === 'payment_screenshot_received' &&
            chatId &&
            message.message_id
          ) {
            await forwardTelegramMessage(MASTER_TELEGRAM_ID, chatId, message.message_id);
          }
        }
      } catch (notifyErr) {
        console.error('Master notification failed:', notifyErr);
      }
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
    wants_to_book: fields.wants_to_book ?? null,
    contact_preference: fields.contact_preference ?? null,
    contact_value: fields.contact_value ?? null,
    phone: fields.phone ?? null,
    payment_status: fields.deposit_status ?? null, // колонка в Airtable зовётся deposit_status
    client_type: fields.client_type ?? null,
    skin_notes: fields.skin_notes ?? null,
    spam_count: fields.spam_count ?? 0,
    chosen_slot_id: fields.chosen_slot_id ?? null,
    slot_options: parseSlotOptions(fields.slot_options),
    photos_count: fields.photos_count ?? 0,
    has_photo_this_message: false,
    photo_has_caption: false,
    force_client_mode: fields.force_client_mode ?? null,
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
    phone: string | null;
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
    phone: extracted.phone ?? current.phone,
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
    wants_to_book: card.wants_to_book,
    contact_preference: card.contact_preference,
    contact_value: card.contact_value,
    phone: card.phone,
    deposit_status: card.payment_status, // колонка в Airtable зовётся deposit_status
    skin_notes: card.skin_notes,
    spam_count: card.spam_count,
    chosen_slot_id: card.chosen_slot_id,
    slot_options: card.slot_options ? card.slot_options.join(',') : '',
    photos_count: extra.photos_count,
    force_client_mode: card.force_client_mode,
  };
}

// Текст уведомления мастеру для тех шагов, где Ане нужно что-то узнать
// или сделать. Возвращает null для шагов, не требующих её внимания —
// тогда пинг не отправляется вовсе.
function buildMasterNotification(
  step: NextStep,
  clientLabel: string,
  username: string
): string | null {
  const who = username ? `${clientLabel} (@${username})` : clientLabel;
  switch (step) {
    case 'confirm_slot_awaiting_payment':
      return `🎨 Новая бронь ТАТУ — ${who}. Слот закреплён, клиент ждёт реквизиты для предоплаты 200₪.`;
    case 'confirm_consultation_booked':
      return `🗓 Новая КОНСУЛЬТАЦИЯ — ${who}. Слот забронирован.`;
    case 'payment_screenshot_received':
      return `💰 ${who} прислал скрин предоплаты — проверь сумму и подтверди оплату (скрин переслан ниже).`;
    case 'reschedule_requested_ping_master':
      return `🔄 ${who} просит перенести запись — напиши насчёт нового времени.`;
    case 'slot_change_requested_waiting':
    case 'no_more_slots_waiting':
      return `⏳ ${who} в листе ожидания — подходящих слотов сейчас нет.`;
    default:
      return null;
  }
}

async function forwardTelegramMessage(
  toChatId: number,
  fromChatId: number,
  messageId: number
) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN not set');
    return;
  }
  const url = `https://api.telegram.org/bot${token}/forwardMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: toChatId,
      from_chat_id: fromChatId,
      message_id: messageId,
    }),
  });
}

// Блок реквизитов предоплаты, собранный из env-переменных. Клиенту
// предлагается два способа на выбор: Bit (по номеру телефона) и
// банковский перевод. Если ни один реквизит не задан в env — возвращаем
// null (тогда сообщение уходит без блока, а не с битым текстом).
// Env: PAYMENT_BIT (номер для Bit), PAYMENT_BANK (реквизиты банка).
function buildPaymentDetailsBlock(): string | null {
  const bit = (process.env.PAYMENT_BIT ?? '').trim();
  const bank = (process.env.PAYMENT_BANK ?? '').trim();
  if (!bit && !bank) {
    console.warn('PAYMENT_BIT / PAYMENT_BANK not set — payment details block skipped');
    return null;
  }

  const lines = ['реквизиты для предоплаты 200₪ (на выбор):'];
  if (bit) lines.push(`📱 Bit: ${bit}`);
  if (bank) lines.push(`🏦 банковский перевод: ${bank}`);
  lines.push('после оплаты пришли, пожалуйста, скрин 🙏');
  return lines.join('\n');
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
