// ============================================================
// INKA-BOT — State Machine
// Чистый TypeScript, БЕЗ вызовов LLM.
// Источник логики: INKA_MASTER_PRODUCTION_v1_0.txt
//   (разделы "STATE MACHINE: КАК ВЫБИРАТЬ СЛЕДУЮЩИЙ ШАГ" и
//    "ВНУТРЕННЕЕ СОСТОЯНИЕ")
// Источник цены/маршрута: INKANYA_PRICE_v1_2.txt
//   (направление: direct_tattoo_allowed / consultation_needed
//    уже посчитаны Extractor-ом по правилам прайса — здесь их
//    НЕ пересчитываем, только используем)
// ============================================================

// ----------------------------------------------------------
// ТИПЫ
// ----------------------------------------------------------

export type Intent =
  | 'admin_test'
  | 'idea'
  | 'price'
  | 'booking'
  | 'consultation'
  | 'existing_tattoo'
  | 'out_of_scope'
  | 'prompt_injection'
  | 'unclear';

export type LeadStatus =
  | 'new'
  | 'diagnosing'
  | 'estimated'
  | 'wants_booking'
  | 'slots_shown'
  | 'consultation_booked'
  | 'tattoo_booked_waiting_payment'
  | 'waiting_slots'
  | 'waiting_slots_pinged'
  | 'blocked';

export type Category =
  | 'mini'
  | 'small'
  | 'medium'
  | 'medium_big'
  | 'large'
  | 'body_fit'
  | 'project'
  | null;

export type YesNo = 'yes' | 'no' | null;
export type ExistingTattoo = 'no' | 'cover' | 'modification' | 'scar_work' | null;
export type ContactPreference = 'telegram' | 'whatsapp' | null;
export type PaymentStatus = 'none' | 'waiting_prepayment' | 'paid' | null;
export type ClientType =
  | '1_undefined'
  | '2_reference'
  | '3_price_only'
  | '4_wants_meeting'
  | '5_anxious'
  | null;

// Карточка клиента — то, что лежит в Airtable + то, что Extractor
// вернул из последнего сообщения, слитое в одну запись.
export interface ClientCard {
  telegram_id: number;
  intent: Intent;
  lead_status: LeadStatus;
  category: Category;
  idea: string | null;
  size: string | null;
  placement: string | null;
  first_tattoo: YesNo;
  existing_tattoo: ExistingTattoo;
  direct_tattoo_allowed: YesNo;
  consultation_needed: YesNo;
  active_work_time_estimate: string | null; // "<=3h" | ">3h" | "unknown" | null
  price_quoted: string | null;
  price_explained: YesNo;
  wants_to_book: YesNo; // явное подтверждение клиента "да, хочу записаться" после цены
  contact_preference: ContactPreference;
  contact_value: string | null;
  payment_status: PaymentStatus;
  client_type: ClientType;
  skin_notes: string | null;
  spam_count: 0 | 1 | 2 | 3;
  chosen_slot_id: string | null;
  slot_options: string[] | null; // реальные слоты, пришедшие из календаря
  photos_count: number;
  has_photo_this_message: boolean;
  photo_has_caption: boolean;
}

// Что Extractor дополнительно сообщает о ТЕКУЩЕМ сообщении —
// не то, что лежит в карточке, а сырые сигналы из этого сообщения.
export interface MessageSignals {
  is_admin_sender: boolean; // telegram_id === 457343487
  is_prompt_injection: boolean;
  is_out_of_scope: boolean;
  client_picked_slot_id: string | null; // id слота, который Extractor распознал в тексте клиента (валидность проверяет state machine, не Extractor)
  client_wants_other_slots: boolean; // "ничего не подходит", "другое время"
  client_asks_for_more_slots: boolean; // "а есть ещё?"
  client_wants_to_reschedule: boolean; // клиент с УЖЕ подтверждённой записью просит перенести
  client_confirms_booking: YesNo; // ответ клиента на "хочешь записаться?" — yes/no/null если не отвечал на этот вопрос сейчас
}

export type NextStep =
  | 'admin_mode'
  | 'silence_blocked'
  | 'handle_prompt_injection'
  | 'handle_out_of_scope_warning_1'
  | 'handle_out_of_scope_warning_2'
  | 'handle_out_of_scope_block'
  | 'handle_photo_no_caption'
  | 'ask_idea'
  | 'ask_placement'
  | 'ask_size'
  | 'ask_existing_tattoo_or_skin'
  | 'ask_skin_notes_detail'
  | 'quote_price'
  | 'ask_wants_to_book'
  | 'ask_first_tattoo'
  | 'ask_contact'
  | 'show_tattoo_slots'
  | 'show_consultation_slots'
  | 'slot_taken_pick_again'
  | 'slot_change_requested_waiting'
  | 'no_more_slots_waiting'
  | 'reschedule_requested_ping_master'
  | 'confirm_slot_awaiting_payment'
  | 'confirm_consultation_booked'
  | 'all_done';

// ----------------------------------------------------------
// ГЛАВНАЯ ФУНКЦИЯ
// ----------------------------------------------------------

export function getNextStep(card: ClientCard, signals: MessageSignals): NextStep {
  // 1. РЕЖИМ — admin/test проверяется первым, выше всего остального.
  // (раздел "AUTHOR / ADMIN / TEST MODE": admin не запускает клиентский
  // state machine вообще)
  //
  // ⚠️ ЗАГЛУШКА: 'admin_mode' здесь — просто флаг "это мастер, не клиент".
  // Сама начинка admin-режима (счёт по запросу, психологический портрет
  // клиента, лист ожидания, календарь на день, статистика) — отдельный
  // модуль lib/admin.ts, строится на ШАГЕ 7, после Calendar/booking.
  // До шага 7 telegram.ts должен просто ответить чем-то заглушечным
  // на admin_mode (например "admin-режим пока в разработке").
  if (signals.is_admin_sender) {
    return 'admin_mode';
  }

  // 2. БЛОКИРОВКА — только клиентский режим.
  if (card.lead_status === 'blocked') {
    return 'silence_blocked';
  }

  // 3. PROMPT INJECTION — проверяется раньше диагностики.
  if (signals.is_prompt_injection) {
    return 'handle_prompt_injection';
  }

  // 4. OUT OF SCOPE — три предупреждения, потом блок.
  // (раздел 2: первый раз — вернуть к теме, второй — повторить
  // границу, третий — lead_status = blocked)
  if (signals.is_out_of_scope) {
    if (card.spam_count === 0) return 'handle_out_of_scope_warning_1';
    if (card.spam_count === 1) return 'handle_out_of_scope_warning_2';
    return 'handle_out_of_scope_block'; // ставит lead_status=blocked в Airtable
  }

  // 5. ФОТО без подписи — отдельная ветка, один вопрос.
  // (раздел 3: "сохранила. что из фото важно...")
  if (card.has_photo_this_message && !card.photo_has_caption) {
    return 'handle_photo_no_caption';
  }

  // 6. ПЕРЕНОС УЖЕ ПОДТВЕРЖДЁННОЙ ЗАПИСИ.
  // Инка САМА НЕ переносит встречи — она только спокойно фиксирует
  // запрос и явно пингует мастера. Проверяем раньше блока "слоты
  // показаны", потому что это другая ситуация: запись уже состоялась,
  // а не на стадии выбора варианта.
  if (
    signals.client_wants_to_reschedule &&
    (card.lead_status === 'tattoo_booked_waiting_payment' ||
      card.lead_status === 'consultation_booked')
  ) {
    return 'reschedule_requested_ping_master';
  }

  // 7. СЛОТЫ УЖЕ ПОКАЗАНЫ — обрабатываем раньше, чем заново считать цену.
  // (раздел 4: lead_status = slots_shown)
  if (card.lead_status === 'slots_shown') {
    if (signals.client_picked_slot_id) {
      // Валидность выбора проверяет САМ КОД — сверяем id со списком
      // актуальных slot_options, а не доверяем LLM-сигналу напрямую.
      // Это надёжнее: занятость слота — факт календаря, не интерпретация
      // текста. Если id не входит в текущий список — слот уже занят
      // или устарел.
      const isValidChoice =
        !!card.slot_options && card.slot_options.includes(signals.client_picked_slot_id);

      if (!isValidChoice) {
        return 'slot_taken_pick_again';
      }

      // Выбор валиден: дальше либо подтверждение тату (ожидание оплаты),
      // либо подтверждение консультации — зависит от того, какие слоты
      // показывались (direct_tattoo_allowed/consultation_needed карточки).
      if (card.direct_tattoo_allowed === 'yes') {
        return 'confirm_slot_awaiting_payment';
      }
      return 'confirm_consultation_booked';
    }
    if (signals.client_wants_other_slots) {
      return 'slot_change_requested_waiting'; // chosen_slot_id=null, lead_status=waiting_slots
    }
    if (signals.client_asks_for_more_slots) {
      if (card.slot_options && card.slot_options.length > 0) {
        // ещё есть реальные варианты — показать тот же show_* шаг повторно
        return card.direct_tattoo_allowed === 'yes'
          ? 'show_tattoo_slots'
          : 'show_consultation_slots';
      }
      return 'no_more_slots_waiting'; // chosen_slot_id=null, lead_status=waiting_slots
    }
    // Клиент написал что-то непонятное при показанных слотах — просим
    // выбрать явно один из списка.
    return 'slot_taken_pick_again';
  }

  // 8. СБОР ДАННЫХ ДЛЯ ЦЕНЫ — idea → placement → size → existing_tattoo.
  // (раздел 5: порядок — приоритет, не жёсткая цепочка; Responder может
  // объединить 2-3 поля в один вопрос, это не задача state machine)
  if (!card.idea) return 'ask_idea';
  if (!card.placement) return 'ask_placement';
  if (!card.size) return 'ask_size';
  if (!card.existing_tattoo) return 'ask_existing_tattoo_or_skin';

  // 9. СЛОЖНАЯ КОЖА / КАВЕР / ШРАМЫ — уточнить skin_notes если применимо.
  // (раздел 6: если есть кавер/шрам/непонятная кожа и skin_notes пусто)
  const needsSkinDetail =
    (card.existing_tattoo === 'cover' ||
      card.existing_tattoo === 'modification' ||
      card.existing_tattoo === 'scar_work') &&
    !card.skin_notes;
  if (needsSkinDetail) {
    return 'ask_skin_notes_detail';
  }

  // 10. ЦЕНА ПЕРЕД ЛЮБЫМ СЛЕДУЮЩИМ ШАГОМ.
  // category/direct_tattoo_allowed/consultation_needed к этому моменту
  // уже должны быть посчитаны Extractor-ом (по правилам PRICE v1.2) —
  // state machine их не пересчитывает, только проверяет наличие цены.
  const hasPrice = !!card.price_quoted || card.price_explained === 'yes';
  if (!hasPrice) {
    return 'quote_price';
  }

  // 10b. ПОДТВЕРЖДЕНИЕ НАМЕРЕНИЯ ЗАПИСАТЬСЯ.
  // Клиент мог спрашивать цену просто из интереса, без намерения
  // записываться прямо сейчас. Не тянем контакт/слоты без явного "да" —
  // спрашиваем отдельно и ждём подтверждения. effectiveWantsToBook
  // приоритизирует свежий сигнал из ТЕКУЩЕГО сообщения (signals) над
  // тем, что уже сохранено в карточке — клиент мог передумать.
  const effectiveWantsToBook = signals.client_confirms_booking ?? card.wants_to_book;
  if (effectiveWantsToBook === null) {
    return 'ask_wants_to_book';
  }
  if (effectiveWantsToBook === 'no') {
    return 'all_done';
  }

  // 11a. ПРЯМОЙ ПУТЬ НА ТАТУ
  if (card.direct_tattoo_allowed === 'yes') {
    // price_explained недостаточно для тату-слотов — нужен именно price_quoted.
    if (!card.price_quoted) {
      return 'quote_price';
    }
    if (card.first_tattoo === null) {
      return 'ask_first_tattoo';
    }
    // Контакт считается известным, если выбран telegram (тогда отдельное
    // значение не нужно — пишем в тот же чат по telegram_id) ИЛИ если
    // выбран whatsapp И дано конкретное значение (номер).
    const hasContact =
      card.contact_preference === 'telegram' ||
      (card.contact_preference === 'whatsapp' && !!card.contact_value);
    if (!hasContact) {
      return 'ask_contact';
    }
    if (card.slot_options && card.slot_options.length > 0) {
      return 'show_tattoo_slots';
    }
    return 'no_more_slots_waiting'; // нет реальных слотов — в лист ожидания
  }

  // 11b. КОНСУЛЬТАЦИОННЫЙ ПУТЬ
  if (card.consultation_needed === 'yes') {
    const hasContact =
      card.contact_preference === 'telegram' ||
      (card.contact_preference === 'whatsapp' && !!card.contact_value);
    if (!hasContact) {
      return 'ask_contact';
    }
    if (card.slot_options && card.slot_options.length > 0) {
      return 'show_consultation_slots';
    }
    return 'no_more_slots_waiting';
  }

  // Если ни direct_tattoo_allowed, ни consultation_needed ещё не выставлены
  // Extractor-ом (например, потому что category всё ещё null) — возвращаемся
  // к сбору цены. Это защитный fallback, в норме сюда не попадаем, если
  // Extractor честно выставил оба поля после category.
  return 'quote_price';
}

// ----------------------------------------------------------
// ПОМОЩНИК: какие изменения карточки происходят НА ЭТОМ шаге
// (то, что state machine обязана записать обратно в Airtable,
// помимо того что вернул Extractor)
// ----------------------------------------------------------

export interface CardPatch {
  lead_status?: LeadStatus;
  spam_count?: 0 | 1 | 2 | 3;
  chosen_slot_id?: string | null;
  wants_to_book?: YesNo;
}

export function getCardPatchForStep(
  step: NextStep,
  card: ClientCard,
  signals: MessageSignals
): CardPatch {
  // wants_to_book сохраняется в карточку НАВСЕГДА, в отличие от
  // большинства signals полей — это не разовый сигнал сообщения, а
  // факт про клиента, который должен помниться на следующих шагах.
  const patch: CardPatch = {};
  if (signals.client_confirms_booking !== null) {
    patch.wants_to_book = signals.client_confirms_booking;
  }

  switch (step) {
    case 'handle_out_of_scope_warning_1':
      return { ...patch, spam_count: 1 };
    case 'handle_out_of_scope_warning_2':
      return { ...patch, spam_count: 2 };
    case 'handle_out_of_scope_block':
      return { ...patch, spam_count: 3, lead_status: 'blocked' };
    case 'reschedule_requested_ping_master':
      return { ...patch, lead_status: 'waiting_slots_pinged' };
    case 'slot_change_requested_waiting':
    case 'no_more_slots_waiting':
      return { ...patch, chosen_slot_id: null, lead_status: 'waiting_slots' };
    case 'show_tattoo_slots':
    case 'show_consultation_slots':
      return { ...patch, lead_status: 'slots_shown' };
    case 'confirm_slot_awaiting_payment':
      return { ...patch, lead_status: 'tattoo_booked_waiting_payment' };
    case 'confirm_consultation_booked':
      return { ...patch, lead_status: 'consultation_booked' };
    default:
      return patch;
  }
}
