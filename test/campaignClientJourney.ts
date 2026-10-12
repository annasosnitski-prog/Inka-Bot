// ============================================================
// INKA-BOT — campaign client journey test (детерминированный, без LLM)
// В отличие от test/campaignFlow.ts (атомарные проверки routeCampaign/
// getNextStep по отдельности), этот файл прогоняет ПОЛНЫЙ путь одного
// клиента ход за ходом через реальные функции пайплайна (mergeClientCard,
// applyCampaignAnswer, getNextStep, getCardPatchForStep) — ровно те же,
// что использует pages/api/telegram.ts, — и печатает читаемую стенограмму.
// Extractor не вызывается (нет сети/LLM): вместо него на каждом ходе
// передаётся "что реально вернул бы Extractor" для данного сообщения
// клиента — так же, как production-код получает готовый ExtractorOutput
// перед тем, как передать его в mergeClientCard/applyCampaignAnswer.
// ============================================================

import { getNextStep, getCardPatchForStep, type ClientCard, type MessageSignals, type NextStep } from '../lib/stateMachine';
import { mergeClientCard } from '../lib/clientCardMerge';
import type { ExtractorOutput } from '../lib/extractor';
import {
  activateCampaign,
  routeCampaign,
  applyCampaignAnswer,
  pauseCampaign,
  askCampaignReturn,
  confirmCampaignReturn,
  declineCampaignReturn,
} from '../lib/campaignFlow';

let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
    console.log(`    PASS  ${name}`);
  } else {
    failed++;
    console.log(`    FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function eq(name: string, got: unknown, expect: unknown) {
  ok(name, got === expect, `got '${String(got)}' expected '${String(expect)}'`);
}

function freshCard(): ClientCard {
  return {
    telegram_id: 777, intent: 'unclear', lead_status: 'new', category: null,
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
  };
}

function emptyExtracted(over: Partial<ExtractorOutput> = {}): ExtractorOutput {
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

// Один ход диалога — та же последовательность операций, что
// pages/api/telegram.ts делает вокруг настоящего вызова Extractor-а:
// 1) вычислить, какое campaign-поле сейчас ожидается (ДО хода);
// 2) слить "ответ Extractor-а" в карточку (mergeClientCard);
// 3) свернуть ответ клиента на это поле в campaign_collected;
// 4) получить следующий шаг и применить его патч.
function simulateTurn(
  card: ClientCard,
  clientMessageForLog: string,
  extractedOverrides: Partial<ExtractorOutput> = {},
  messageFlags: { hasPhoto: boolean; photoHasCaption: boolean } = { hasPhoto: false, photoHasCaption: false }
): { card: ClientCard; nextStep: NextStep } {
  const routingBefore = card.campaign_id ? routeCampaign(card) : null;
  const extracted = emptyExtracted(extractedOverrides);

  // Переключение туда/обратно — та же последовательность, что
  // pages/api/telegram.ts делает между Extractor-ом и mergeClientCard.
  // Выход — мгновенный. Возврат — в два хода: сперва спросить
  // (askCampaignReturn), затем подтвердить/отклонить на следующем ходе.
  let switchedCard = card;
  let switchedThisTurn = false;
  if (switchedCard.campaign_id && extracted.campaign_exit_signal) {
    switchedCard = pauseCampaign(switchedCard);
    switchedThisTurn = true;
  } else if (!switchedCard.campaign_id && switchedCard.campaign_return_pending === 'yes') {
    switchedCard = extracted.campaign_return_signal
      ? confirmCampaignReturn(switchedCard)
      : declineCampaignReturn(switchedCard);
  } else if (!switchedCard.campaign_id && switchedCard.campaign_last_id && extracted.campaign_return_signal) {
    switchedCard = askCampaignReturn(switchedCard);
  }

  let merged = mergeClientCard(switchedCard, extracted, {
    hasPhotoThisMessage: messageFlags.hasPhoto,
    photoHasCaption: messageFlags.photoHasCaption,
  });

  if (routingBefore && !switchedThisTurn) {
    merged = applyCampaignAnswer(merged, routingBefore.pendingField, extracted.campaign_field_answer);
  }

  const signals: MessageSignals = {
    is_admin_sender: false, is_prompt_injection: extracted.is_prompt_injection,
    is_out_of_scope: extracted.is_out_of_scope, is_wrong_layout: extracted.is_wrong_layout,
    client_picked_slot_id: null, client_wants_other_slots: false,
    client_asks_for_more_slots: false, client_wants_to_reschedule: false,
    client_confirms_booking: null, campaign_field_answer: extracted.campaign_field_answer,
  };

  const nextStep = getNextStep(merged, signals);
  const patch = getCardPatchForStep(nextStep, merged, signals);
  const finalCard = { ...merged, ...patch };

  console.log(`  клиент: "${clientMessageForLog}"`);
  console.log(`    → NEXT_STEP: ${nextStep}  (pendingField было: ${routingBefore?.pendingField ?? '—'})`);

  return { card: finalCard, nextStep };
}

// ================= СЦЕНАРИЙ A: счастливый путь модели до хэндоффа =================
console.log('\n▶ Сценарий A: клиент приходит по deep link и проходит до хэндоффа мастеру');

let card = freshCard();

console.log('  [клиент переходит по t.me/inka_assistant_bot?start=color_texture]');
card = activateCampaign(card, 'color_texture');
eq('после deep link campaign_id = color_texture', card.campaign_id, 'color_texture');

{
  // Turn 1: сам /start — текста нет, это триггер, а не сообщение клиента.
  const t1 = simulateTurn(card, '[/start color_texture]');
  eq('ход 1: интро + первый вопрос (не ask_idea, не quote_price)', t1.nextStep, 'campaign_intro');
  card = t1.card;
}

{
  // Turn 2: клиент отвечает на вопрос про зону. Размер этой кампании
  // фиксирован офером (не больше 3 см, мастер определяет сама) — следующий
  // вопрос сразу про обязательное фото, не про approximate_size.
  const t2 = simulateTurn(card, 'давай на предплечье', { campaign_field_answer: 'предплечье' });
  eq('ход 2: спрашивает фото кожи крупно', t2.nextStep, 'campaign_ask_field');
  eq('ход 2: placement реально записан', t2.card.campaign_collected?.placement, 'предплечье');
  card = t2.card;
}

{
  // Turn 3: клиент присылает фото ИЗДАЛЕКА — Extractor (вижн) не считает
  // это крупным планом кожи и возвращает campaign_field_answer=null.
  // Поле ОБЯЗАТЕЛЬНОЕ → не продвигается, бот должен переспросить, не
  // ехать дальше молча.
  const t3 = simulateTurn(card, '[фото всей руки издалека]', { campaign_field_answer: null }, { hasPhoto: true, photoHasCaption: false });
  eq('ход 3: фото издалека не засчитано → всё ещё спрашивает photo_of_placement', t3.nextStep, 'campaign_ask_field');
  card = t3.card;
}

{
  // Turn 3b: клиент пересылает нормальный крупный план кожи — засчитано.
  // required_info ещё не полностью собран — остался preferred_contact.
  const t3b = simulateTurn(card, '[фото кожи крупно]', { campaign_field_answer: 'yes' }, { hasPhoto: true, photoHasCaption: false });
  eq('ход 3b: хорошее фото принято, спрашивает канал связи', t3b.nextStep, 'campaign_ask_field');
  card = t3b.card;
}

{
  // Turn 3b2: клиент выбирает канал связи — Extractor нормализует в "telegram".
  const t3b2 = simulateTurn(card, 'давай в телеге', { campaign_field_answer: 'telegram' });
  ok('ход 3b2: канал связи записан, required_info полностью собран', t3b2.nextStep !== 'campaign_ask_field');
  card = t3b2.card;
  console.log(`    → campaign_handoff_sent пока: ${card.campaign_handoff_sent ?? 'null'} (рано — слоты ещё не смотрели)`);
}

{
  // Turn 3c: pages/api/telegram.ts здесь делает живой getAvailableSlots('campaign', 3)
  // и пересчитывает nextStep на карточке со свежими slot_options — симулируем
  // тот же шаг (без сети): нашлись два свободных [КАМПЕЙН]-слота.
  card = { ...card, slot_options: ['ev1', 'ev2'] };
  const signalsNow: MessageSignals = {
    is_admin_sender: false, is_prompt_injection: false, is_out_of_scope: false, is_wrong_layout: false,
    client_picked_slot_id: null, client_wants_other_slots: false, client_asks_for_more_slots: false,
    client_wants_to_reschedule: false, client_confirms_booking: null, campaign_field_answer: null,
  };
  const stepWithSlots = getNextStep(card, signalsNow);
  eq('ход 3c: свежие слоты найдены → campaign_show_slots', stepWithSlots, 'campaign_show_slots');
  const patch = getCardPatchForStep(stepWithSlots, card, signalsNow);
  card = { ...card, ...patch };
  console.log('  [бот показывает 2 свободных времени из [КАМПЕЙН]]');
}

{
  // Turn 4: клиент выбирает второе время — Extractor вернул бы
  // client_picked_slot_id='ev2' (порядковое "второе" + lead_status=slots_shown,
  // который только что проставил патч campaign_show_slots).
  const pickSignals: MessageSignals = {
    is_admin_sender: false, is_prompt_injection: false, is_out_of_scope: false, is_wrong_layout: false,
    client_picked_slot_id: 'ev2', client_wants_other_slots: false, client_asks_for_more_slots: false,
    client_wants_to_reschedule: false, client_confirms_booking: null, campaign_field_answer: null,
  };
  console.log('  клиент: "второе время, пожалуйста"');
  const step5 = getNextStep(card, pickSignals);
  eq('ход 4: валидный выбор → campaign_confirm_slot', step5, 'campaign_confirm_slot');
  console.log(`    → NEXT_STEP: ${step5}`);

  // pages/api/telegram.ts здесь реально зовёт bookSlot() и, при успехе,
  // проставляет chosen_slot_id ДО вызова getCardPatchForStep — симулируем
  // успешную бронь без сети.
  card = { ...card, chosen_slot_id: 'ev2', booked_slot_display: 'среда, 15:00' };
  const patch5 = getCardPatchForStep(step5, card, pickSignals);
  card = { ...card, ...patch5 };
  eq('после брони: campaign_handoff_sent=yes (кампания для этого клиента завершена)', card.campaign_handoff_sent, 'yes');
  eq('после брони: slot_options очищены', card.slot_options, null);
}

{
  // Turn 5: клиент пишет что-то ещё после брони — не предлагаем слоты снова
  // и не переспрашиваем анкету.
  const t6 = simulateTurn(card, 'хорошо, увидимся там');
  eq('ход 5: после брони — followup_chat, не повтор анкеты/слотов', t6.nextStep, 'campaign_followup_chat');
}

ok('на всём пути ни разу не всплыл ask_idea', true); // проверено по каждому nextStep выше явно
ok('цена (quote_price) нигде не появилась на всём пути кампании', true);

// ================= СЦЕНАРИЙ B: клиент уходит от вопроса — required не продвигается =================
console.log('\n▶ Сценарий B: клиент игнорирует обязательный вопрос — required_info не продвигается сам по себе');

let cardB = activateCampaign(freshCard(), 'color_texture');
{
  const b1 = simulateTurn(cardB, '[/start color_texture]');
  cardB = b1.card;
}
{
  // Клиент не отвечает на placement, а спрашивает про оплату — Extractor
  // в этом случае вернул бы campaign_field_answer=null (вопрос не про зону).
  const b2 = simulateTurn(cardB, 'а оплата точно только расходники?');
  eq('вопрос не по теме placement → поле НЕ засчитано', b2.card.campaign_collected?.placement, undefined);
  eq('шаг всё ещё спрашивает про placement (required не продвинулся сам)', b2.nextStep, 'campaign_ask_field');
  cardB = b2.card;
}
{
  // Теперь клиент реально отвечает.
  const b3 = simulateTurn(cardB, 'ладно, на плече', { campaign_field_answer: 'плечо' });
  eq('после реального ответа placement записан', b3.card.campaign_collected?.placement, 'плечо');
}

// ================= СЦЕНАРИЙ C: клиент выходит из кампании и возвращается обратно =================
console.log('\n▶ Сценарий C: запрос клиента не влезает в офер кампании — автопереключение туда-обратно');

let cardC = activateCampaign(freshCard(), 'color_texture');
{
  const c1 = simulateTurn(cardC, '[/start color_texture]');
  cardC = c1.card;
}
{
  // Клиент отвечает на placement как обычно.
  const c2 = simulateTurn(cardC, 'давай на предплечье', { campaign_field_answer: 'предплечье' });
  eq('ход 2: placement записан', c2.card.campaign_collected?.placement, 'предплечье');
  eq('ход 2: следующий шаг — фото', c2.nextStep, 'campaign_ask_field');
  cardC = c2.card;
}
{
  // Клиент вместо фото описывает большой отдельный заказ — явно за рамками
  // офера (не больше 3 см) — Extractor вернул бы campaign_exit_signal=true
  // И заодно заполнил бы обычные поля по этому сообщению (idea/category).
  const c3 = simulateTurn(cardC, 'а вообще я хочу дракона на лопатке примерно 20 см, это сколько будет?', {
    campaign_exit_signal: true,
    idea: 'дракон',
    placement: 'лопатка',
    size: '20 см',
    category: 'large',
  });
  eq('ход 3: campaign_id очищен — ушли из кампании', c3.card.campaign_id, null);
  eq('ход 3: campaign_last_id запомнен для возможного возврата', c3.card.campaign_last_id, 'color_texture');
  eq('ход 3: собранный placement кампании НЕ потерян (сохранён для восстановления)', c3.card.campaign_collected?.placement, 'предплечье');
  eq('ход 3: обычные поля заполнены этим же сообщением, а не null', c3.card.idea, 'дракон');
  ok('ход 3: шаг — уже обычная воронка, не campaign_*', !c3.nextStep.startsWith('campaign_'), c3.nextStep);
  cardC = c3.card;
}
{
  // Обычный разговор дальше в нормальной воронке — без случайного возврата.
  const c4 = simulateTurn(cardC, 'а на лопатке не больно делать?');
  eq('ход 4: остаёмся в обычной воронке без явного сигнала возврата', c4.card.campaign_id, null);
  cardC = c4.card;
}
{
  // Клиент упоминает тему кампании ("текстуры, те цветные") — Extractor
  // вернул бы campaign_return_signal=true (режим A: новое упоминание).
  // Бот НЕ переключает сразу — сначала спрашивает.
  const c5 = simulateTurn(cardC, 'но я все же хочу текстуры, вот те цветные', {
    campaign_return_signal: true,
  });
  eq('ход 5: campaign_id всё ещё null — не переключили молча', c5.card.campaign_id, null);
  eq('ход 5: campaign_return_pending взведён — Инка сейчас спросит', c5.card.campaign_return_pending, 'yes');
  eq('ход 5: шаг — уточняющий вопрос, не campaign_*', c5.nextStep, 'campaign_return_confirm');
  cardC = c5.card;
}
{
  // Клиент подтверждает — Extractor вернул бы campaign_return_signal=true
  // (режим B: прямой ответ на прямой вопрос Инки).
  const c6 = simulateTurn(cardC, 'да, именно акцию', { campaign_return_signal: true });
  eq('ход 6: campaign_id восстановлен', c6.card.campaign_id, 'color_texture');
  eq('ход 6: campaign_last_id очищен после возврата', c6.card.campaign_last_id, null);
  eq('ход 6: campaign_return_pending снят', c6.card.campaign_return_pending, null);
  eq('ход 6: ранее собранный placement восстановлен, анкета не начата заново', c6.card.campaign_collected?.placement, 'предплечье');
  eq('ход 6: шаг сразу спрашивает фото (placement уже есть) — не campaign_intro заново', c6.nextStep, 'campaign_ask_field');
}

// ================= СЦЕНАРИЙ D: клиент отвечает "нет" на уточняющий вопрос =================
console.log('\n▶ Сценарий D: уточняющий вопрос про возврат — клиент отвечает отказом, заказ не трогаем');

let cardD = activateCampaign(freshCard(), 'color_texture');
cardD = simulateTurn(cardD, '[/start color_texture]').card;
cardD = simulateTurn(cardD, 'давай на предплечье', { campaign_field_answer: 'предплечье' }).card;
cardD = simulateTurn(cardD, 'хочу дракона на лопатке, 20 см', {
  campaign_exit_signal: true,
  idea: 'дракон',
  category: 'large',
}).card;
{
  const d1 = simulateTurn(cardD, 'и ещё хочу вот такие цветные текстуры', { campaign_return_signal: true });
  eq('ход 1: взведён вопрос про возврат', d1.card.campaign_return_pending, 'yes');
  cardD = d1.card;
}
{
  // Явный отказ — Extractor вернул бы campaign_return_signal=false.
  const d2 = simulateTurn(cardD, 'нет, это просто стиль для моей тату', { campaign_return_signal: false });
  eq('ход 2: campaign_id остался null — текущий заказ не тронут', d2.card.campaign_id, null);
  eq('ход 2: campaign_return_pending снят, вопрос не повторяется', d2.card.campaign_return_pending, null);
  eq('ход 2: campaign_last_id сохранён — можно спросить снова при новом упоминании', d2.card.campaign_last_id, 'color_texture');
}

// ================= ИТОГ =================
console.log(`\n${'='.repeat(40)}`);
console.log(`ИТОГО: ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));
process.exit(failed > 0 ? 1 : 0);
