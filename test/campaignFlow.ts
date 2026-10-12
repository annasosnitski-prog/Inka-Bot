// ============================================================
// INKA-BOT — campaign flow tests (детерминированная логика, без LLM)
// Покрывает требования из задачи на кампейн/рекрутинг-модуль:
// активация по /start, устойчивость campaign_id между сообщениями,
// изоляция от обычной тату-воронки (pricingRules/ask_idea/quote_price),
// master-approval хэндофф, обратная совместимость с обычным клиентом и
// безопасный фолбэк на неизвестной/переключённой кампании.
// ============================================================

import { getNextStep, getCardPatchForStep, type ClientCard, type MessageSignals } from '../lib/stateMachine';
import { mergeClientCard } from '../lib/clientCardMerge';
import type { ExtractorOutput } from '../lib/extractor';
import { getCampaign } from '../lib/campaigns';
import { routeCampaign, activateCampaign, applyCampaignAnswer, parseCampaignData, serializeCampaignData } from '../lib/campaignFlow';

let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function eq(name: string, got: unknown, expect: unknown) {
  ok(name, got === expect, `got '${String(got)}' expected '${String(expect)}'`);
}

function card(over: Partial<ClientCard> = {}): ClientCard {
  return {
    telegram_id: 1, intent: 'unclear', lead_status: 'new', category: null,
    idea: null, size: null, placement: null, first_tattoo: null,
    existing_tattoo: null, direct_tattoo_allowed: null, consultation_needed: null,
    active_work_time_estimate: null, price_quoted: null, price_explained: null,
    price_factors: null, price_shown: null, wants_to_book: null,
    decline_followup_asked: null, phone: null, client_name: null,
    contact_channel: null, social_link: null, social_asked: null,
    payment_status: null, client_type: null, skin_notes: null, spam_count: 0,
    chosen_slot_id: null, slot_options: null, booked_slot_display: null,
    booked_slot_start_iso: null, payment_reminder_sent: null, booked_at: null,
    payment_reminder_early_sent: null, reference_asked: null, photos_count: 0,
    has_photo_this_message: false, photo_has_caption: false, force_client_mode: null,
    service_fit: null, second_project_flagged: null,
    campaign_id: null, campaign_collected: null, campaign_handoff_sent: null, campaign_last_id: null, campaign_return_pending: null,
    ...over,
  };
}

function sig(over: Partial<MessageSignals> = {}): MessageSignals {
  return {
    is_admin_sender: false, is_prompt_injection: false, is_out_of_scope: false,
    is_wrong_layout: false, client_picked_slot_id: null, client_wants_other_slots: false,
    client_asks_for_more_slots: false, client_wants_to_reschedule: false,
    client_confirms_booking: null, campaign_field_answer: null,
    ...over,
  };
}

function extracted(over: Partial<ExtractorOutput> = {}): ExtractorOutput {
  return {
    intent: 'unclear', idea: null, placement: null, size: null, existing_tattoo: null,
    skin_notes: null, first_tattoo: null, category: null, active_work_time_estimate: null,
    direct_tattoo_allowed: null, consultation_needed: null, price_quoted: null,
    price_explained: null, price_factors: null, phone: null, client_name: null,
    contact_channel: null, social_link: null, is_prompt_injection: false,
    is_out_of_scope: false, is_wrong_layout: false, has_photo_this_message: false,
    photo_has_caption: false, client_picked_slot_id: null, client_wants_other_slots: false,
    client_asks_for_more_slots: false, client_wants_to_reschedule: false,
    client_confirms_booking: null, service_fit: null, service_fit_reason: null,
    is_new_project_request: false, photo_purpose: null, campaign_field_answer: null,
    campaign_exit_signal: false, campaign_return_signal: false,
    ...over,
  };
}

// ================= 1. /start активирует правильную кампанию =================
console.log('\n▶ 1. /start <payload> активирует правильную кампанию');
eq('getCampaign("color_texture") находит активную кампанию', getCampaign('color_texture')?.id, 'color_texture');
{
  const activated = activateCampaign(card(), 'color_texture');
  eq('activateCampaign ставит campaign_id', activated.campaign_id, 'color_texture');
  eq('activateCampaign сбрасывает collected в {}', JSON.stringify(activated.campaign_collected), '{}');
  const routing = routeCampaign(activated);
  ok('после активации routeCampaign возвращает campaign-шаг', routing !== null && routing.step === 'campaign_intro');
}

// ================= 2. campaign_id переживает сообщения / restart =================
console.log('\n▶ 2. campaign_id сохраняется между сообщениями и серверless-рестартом');
{
  const activated = activateCampaign(card(), 'color_texture');
  // "Второе сообщение" — обычный merge без is_new_project_request.
  const merged = mergeClientCard(activated, extracted({ campaign_field_answer: 'предплечье' }), {
    hasPhotoThisMessage: false,
    photoHasCaption: false,
  });
  eq('campaign_id переживает mergeClientCard (не упомянут ни в одной ветке)', merged.campaign_id, 'color_texture');

  const withAnswer = applyCampaignAnswer(merged, 'placement', 'предплечье');
  eq('applyCampaignAnswer кладёт ответ в campaign_collected', withAnswer.campaign_collected?.placement, 'предплечье');

  // Сериализация в/из Airtable (один Long text field campaign_data) — то,
  // что реально переживает restart serverless-функции.
  const raw = serializeCampaignData(withAnswer);
  const parsedBack = parseCampaignData(raw);
  eq('campaign_data сериализуется/парсится без потерь (collected)', parsedBack.collected?.placement, 'предплечье');
  eq('campaign_data: handoff_sent=false по умолчанию', parsedBack.handoff_sent, null);
}

// ================= 3. Никакой обычной цены из pricingRules =================
console.log('\n▶ 3. кампейн-клиент не получает обычную цену из pricingRules');
{
  const c = activateCampaign(card({ price_quoted: '999₪', price_explained: 'yes', price_shown: 'yes' }), 'color_texture');
  const step = getNextStep(c, sig());
  ok('даже с заполненными price_* полями шаг НЕ quote_price', step !== 'quote_price', step);
  ok('шаг — один из campaign_*', step.startsWith('campaign_'), step);
}

// ================= 4. Не попадает в ask_idea, если идея задана кампанией =================
console.log('\n▶ 4. кампейн-клиент не попадает в ask_idea (идея задана объявлением, не клиентом)');
{
  const c = activateCampaign(card({ idea: null }), 'color_texture');
  const step = getNextStep(c, sig());
  ok('idea=null, но шаг не ask_idea', step !== 'ask_idea', step);
  eq('первый ход — campaign_intro', step, 'campaign_intro');
}

// ================= 5. После required_info — переходим к бронированию слота =================
// color_texture — booking_mode: self_book_slot, так что после сбора данных
// бот сам предлагает/бронирует [КАМПЕЙН]-слот, а не просто передаёт мастеру.
console.log('\n▶ 5. после сбора required_info (+ опциональных) — self_book_slot, не раньше');
{
  let c = activateCampaign(card(), 'color_texture');
  // Шаг 1: интро, спрашивает первое required_info (placement).
  let routing = routeCampaign(c);
  eq('шаг 1: campaign_intro, ожидает placement', `${routing?.step}:${routing?.pendingField}`, 'campaign_intro:placement');
  let patch = getCardPatchForStep('campaign_intro', c, sig());
  c = { ...c, ...patch };

  // Клиент отвечает на placement — размер этой кампании фиксирован офером
  // (не больше 3 см, мастер определяет сама), поэтому следующий вопрос —
  // сразу обязательное фото кожи крупно/с близка, не approximate_size.
  c = applyCampaignAnswer(c, 'placement', 'предплечье');
  routing = routeCampaign(c);
  eq('шаг 2: ask_field, ожидает фото кожи крупно', `${routing?.step}:${routing?.pendingField}`, 'campaign_ask_field:photo_of_placement');
  ok(
    'до фото — ни handoff, ни показ слотов (мастер/бот не должны решать раньше срока)',
    getNextStep(c, sig()) !== 'campaign_handoff' && getNextStep(c, sig()) !== 'campaign_show_slots'
  );
  patch = getCardPatchForStep('campaign_ask_field', c, sig());
  c = { ...c, ...patch };

  // Клиент присылает фото издалека/не в фокусе — Extractor (вижн) не
  // засчитывает его как крупный план кожи и возвращает null → поле
  // ОБЯЗАТЕЛЬНОЕ, поэтому бот переспрашивает, а не едет дальше молча.
  c = applyCampaignAnswer(c, 'photo_of_placement', null);
  routing = routeCampaign(c);
  eq(
    'плохое фото (Extractor вернул null) → required не продвинулся, переспрашивает то же поле',
    `${routing?.step}:${routing?.pendingField}`,
    'campaign_ask_field:photo_of_placement'
  );

  // Клиент присылает нормальный крупный план — Extractor засчитывает "yes".
  c = applyCampaignAnswer(c, 'photo_of_placement', 'yes');
  routing = routeCampaign(c);
  eq('хорошее фото принято → спрашивает предпочитаемый канал связи', `${routing?.step}:${routing?.pendingField}`, 'campaign_ask_field:preferred_contact');
  patch = getCardPatchForStep('campaign_ask_field', c, sig());
  c = { ...c, ...patch };

  // Клиент выбирает Telegram — Extractor нормализует ответ в "telegram".
  c = applyCampaignAnswer(c, 'preferred_contact', 'telegram');
  routing = routeCampaign(c);
  eq('канал связи выбран → required_info полностью собран → campaign_no_slots (слотов ещё не загружали)', routing?.step, 'campaign_no_slots');
}

// ================= 5b. self_book_slot — показ слотов, бронь, завершение =================
console.log('\n▶ 5b. self_book_slot: показ слотов → бронь конкретного слота → followup');
{
  // Карточка, у которой сбор данных уже завершён (эквивалент конца теста 5,
  // включая принятое фото крупно/с близка — поле обязательное).
  let c = activateCampaign(card(), 'color_texture');
  c = applyCampaignAnswer(c, 'placement', 'предплечье');
  c = applyCampaignAnswer(c, 'photo_of_placement', 'yes');
  c = applyCampaignAnswer(c, 'preferred_contact', 'telegram');

  // pages/api/telegram.ts подгрузило свежие [КАМПЕЙН]-слоты из календаря.
  c = { ...c, slot_options: ['ev1', 'ev2'] };
  let routing = routeCampaign(c);
  eq('слоты есть → campaign_show_slots', routing?.step, 'campaign_show_slots');
  let patch = getCardPatchForStep('campaign_show_slots', c, sig());
  eq('патч show_slots: lead_status=slots_shown (чтобы Extractor распознал порядковый выбор)', patch.lead_status, 'slots_shown');
  c = { ...c, ...patch };

  // Клиент выбирает второй слот — getNextStep видит валидный client_picked_slot_id.
  const pickSignals = sig({ client_picked_slot_id: 'ev2' });
  eq('валидный выбор слота → campaign_confirm_slot', getNextStep(c, pickSignals), 'campaign_confirm_slot');

  // pages/api/telegram.ts реально бронирует (bookSlot) и проставляет chosen_slot_id
  // ДО вызова getCardPatchForStep — здесь симулируем результат этого шага.
  c = { ...c, chosen_slot_id: 'ev2', booked_slot_display: 'вторник, 10:00' };
  patch = getCardPatchForStep('campaign_confirm_slot', c, pickSignals);
  eq('патч confirm_slot: campaign_handoff_sent=yes (кампания завершена)', patch.campaign_handoff_sent, 'yes');
  eq('патч confirm_slot: slot_options очищены', patch.slot_options, null);
  c = { ...c, ...patch };

  eq('следующий ход после брони → campaign_followup_chat (не переспрашивает и не предлагает слоты снова)', getNextStep(c, sig()), 'campaign_followup_chat');
}

// ================= 5c. self_book_slot — пустой пул слотов не зацикливает и не ломает =================
console.log('\n▶ 5c. self_book_slot: пустой пул [КАМПЕЙН] → campaign_no_slots, без лишних повторов');
{
  let c = activateCampaign(card(), 'color_texture');
  c = applyCampaignAnswer(c, 'placement', 'плечо');
  c = applyCampaignAnswer(c, 'photo_of_placement', 'yes');
  c = applyCampaignAnswer(c, 'preferred_contact', 'whatsapp');
  // pages/api/telegram.ts попробовало найти слоты — пул пуст.
  c = { ...c, slot_options: [] };

  eq('пустой пул → campaign_no_slots (а не зависает/не падает в handoff)', getNextStep(c, sig()), 'campaign_no_slots');
  let patch = getCardPatchForStep('campaign_no_slots', c, sig());
  eq('патч no_slots: campaign_handoff_sent остаётся null (ждём, пока появится слот)', patch.campaign_handoff_sent, undefined);
  eq('патч no_slots: ставит одноразовый маркер пинга мастеру', patch.campaign_collected?.__no_slots_pinged, '1');
  c = { ...c, ...patch };

  // Повторное сообщение клиента, слотов всё ещё нет — не зацикливается на
  // повторной отправке пинга (это решает код в pages/api/telegram.ts по
  // тому же маркеру), а маршрут остаётся тем же, не "залипает" в handoff.
  eq('повторный ход без слотов → всё ещё campaign_no_slots', getNextStep(c, sig()), 'campaign_no_slots');

  // Мастер добавила слот — следующий ход должен сразу увидеть его.
  c = { ...c, slot_options: ['ev9'] };
  eq('слот появился → campaign_show_slots на следующем ходе', getNextStep(c, sig()), 'campaign_show_slots');
}

// ================= 6. Обычный клиент без campaign_id — воронка не тронута =================
console.log('\n▶ 6. обычный клиент без campaign_id идёт по прежнему flow');
{
  const c = card({ idea: null }); // campaign_id остаётся null
  eq('idea=null, нет кампании → ask_idea как раньше', getNextStep(c, sig()), 'ask_idea');
}
{
  const c = card({
    idea: 'роза', placement: 'предплечье', size: '10см', existing_tattoo: 'no',
    reference_asked: 'yes', direct_tattoo_allowed: 'yes', consultation_needed: 'no',
    price_quoted: '800₪', price_shown: 'yes', wants_to_book: 'yes', phone: '0501112233',
    client_name: 'Маша', social_asked: 'yes', first_tattoo: 'no', slot_options: ['ev1'],
  });
  eq('полностью заполненная обычная карточка → show_tattoo_slots, не задета', getNextStep(c, sig()), 'show_tattoo_slots');
}

// ================= 7. Неизвестный campaign_id — безопасный фолбэк =================
console.log('\n▶ 7. неизвестный/неактивный campaign_id безопасно падает в обычный режим');
eq('getCampaign на мусорный id → null', getCampaign('totally_unknown_campaign'), null);
eq('getCampaign на пустую строку → null', getCampaign(''), null);
eq('getCampaign на null → null', getCampaign(null), null);
{
  // card.campaign_id указывает на несуществующую кампанию (не должно
  // случаться после нормальной активации, но должно быть безопасно).
  const c = card({ campaign_id: 'totally_unknown_campaign', idea: null });
  ok('routeCampaign возвращает null для неизвестной кампании', routeCampaign(c) === null);
  eq('getNextStep безопасно падает в обычный ask_idea, не зависает', getNextStep(c, sig()), 'ask_idea');
}

// ================= 8. Повторный /start переключает кампанию без смешивания =================
console.log('\n▶ 8. повторный /start с другой кампанией переключает флоу и не смешивает данные');
{
  let c = activateCampaign(card(), 'color_texture');
  c = applyCampaignAnswer(c, 'placement', 'предплечье');
  c = applyCampaignAnswer(c, 'photo_of_placement', 'yes');
  c = applyCampaignAnswer(c, 'preferred_contact', 'telegram');
  ok(
    'до переключения: все поля color_texture собраны',
    !!c.campaign_collected?.placement && !!c.campaign_collected?.photo_of_placement && !!c.campaign_collected?.preferred_contact
  );

  // Клиент переходит по ДРУГОЙ кампейн-ссылке (используется здесь только
  // как механический пример другого id — реестр кампаний пока содержит
  // одну полноценную кампанию, см. lib/campaigns.ts).
  const switched = activateCampaign(c, 'male_project');
  eq('campaign_id переключился', switched.campaign_id, 'male_project');
  eq('старые collected-данные НЕ перетекли в новую кампанию', JSON.stringify(switched.campaign_collected), '{}');
  eq('campaign_handoff_sent сброшен при переключении', switched.campaign_handoff_sent, null);
}

// ================= ИТОГ =================
console.log(`\n${'='.repeat(40)}`);
console.log(`ИТОГО: ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));
process.exit(failed > 0 ? 1 : 0);
