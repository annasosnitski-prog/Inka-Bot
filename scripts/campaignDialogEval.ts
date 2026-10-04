// ============================================================
// INKA-BOT — Campaign dialog eval (Extractor + Responder, РЕАЛЬНЫЕ вызовы)
// НЕ часть `npm test`. Прогоняет один реалистичный многоходовой диалог
// кандидата по кампании color_texture через настоящие Extractor/Responder
// (нужен OPENAI_API_KEY) — то, что реально увидел бы клиент, а не
// смоделированные ExtractorOutput (см. test/campaignClientJourney.ts —
// тот файл детерминированный, без сети/LLM; этот — живой, с реальными
// формулировками и реальным поведением модели на каверзные сообщения).
//
// Что живые вызовы могут проверить, а детерминированный тест — нет:
// - реально ли Responder НЕ называет точную сумму (campaign.payment.amount=null);
// - реально ли Extractor не даёт обязательному полю "проскочить" на
//   вопрос не по теме или прямую просьбу пропустить шаг;
// - тон и формулировки на реальных репликах кандидата.
//
// ОГРАНИЧЕНИЕ: у этого скрипта нет настоящего файла фото в Telegram, то
// есть вижн-проверку "крупно/с близка" (lib/campaignExtractorOverlay.txt)
// здесь честно не проверить — после демонстрации того, что просьба
// пропустить фото отклоняется, ответ на это поле подставляется вручную
// (applyCampaignAnswer), а не через реальный вызов с картинкой.
//
// Запуск: OPENAI_API_KEY=... npm run eval:campaign-dialog
// ============================================================

import { runExtractor } from '../lib/extractor';
import { runResponder } from '../lib/responder';
import { mergeClientCard } from '../lib/clientCardMerge';
import { getNextStep, getCardPatchForStep } from '../lib/stateMachine';
import type { ClientCard, MessageSignals, NextStep } from '../lib/stateMachine';
import { activateCampaign, routeCampaign, applyCampaignAnswer } from '../lib/campaignFlow';
import type { RecentDialogTurn } from '../lib/dialogLog';

function freshCard(): ClientCard {
  return {
    telegram_id: 999, intent: 'unclear', lead_status: 'new', category: null,
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
    campaign_id: null, campaign_collected: null, campaign_handoff_sent: null,
  };
}

let anyProblem = false;
function check(label: string, ok: boolean) {
  console.log(`    ${ok ? 'PASS' : 'FAIL'} — ${label}`);
  if (!ok) anyProblem = true;
}

interface TurnOutcome {
  card: ClientCard;
  nextStep: NextStep;
  reply: string;
  history: RecentDialogTurn[];
  extracted: Awaited<ReturnType<typeof runExtractor>>;
}

// Один ход — РЕАЛЬНЫЙ Extractor + РЕАЛЬНЫЙ Responder, та же
// последовательность операций, что pages/api/telegram.ts делает вокруг
// них (campaignRoutingBefore → merge → applyCampaignAnswer → getNextStep
// → getCardPatchForStep).
async function runTurn(
  card: ClientCard,
  history: RecentDialogTurn[],
  clientMessage: string | null,
  opts: { hasPhoto?: boolean; photoCaption?: string | null; slotsDisplay?: string[] | null } = {}
): Promise<TurnOutcome> {
  const campaignRoutingBefore = card.campaign_id ? routeCampaign(card) : null;

  const extracted = await runExtractor({
    currentCard: card,
    messageText: clientMessage,
    hasPhoto: !!opts.hasPhoto,
    photoCaption: opts.photoCaption ?? null,
    isAdminSender: false,
    recentHistory: history,
    photoFileId: null,
    activeCampaign: campaignRoutingBefore
      ? {
          title: campaignRoutingBefore.campaign.title,
          offer: campaignRoutingBefore.campaign.offer,
          pendingField: campaignRoutingBefore.pendingField,
        }
      : null,
  });

  let merged = mergeClientCard(card, extracted, {
    hasPhotoThisMessage: !!opts.hasPhoto,
    photoHasCaption: !!opts.hasPhoto && !!opts.photoCaption,
  });
  if (campaignRoutingBefore) {
    merged = applyCampaignAnswer(merged, campaignRoutingBefore.pendingField, extracted.campaign_field_answer);
  }

  const signals: MessageSignals = {
    is_admin_sender: false,
    is_prompt_injection: extracted.is_prompt_injection,
    is_out_of_scope: extracted.is_out_of_scope,
    is_wrong_layout: extracted.is_wrong_layout,
    client_picked_slot_id: extracted.client_picked_slot_id,
    client_wants_other_slots: extracted.client_wants_other_slots,
    client_asks_for_more_slots: extracted.client_asks_for_more_slots,
    client_wants_to_reschedule: extracted.client_wants_to_reschedule,
    client_confirms_booking: extracted.client_confirms_booking,
    campaign_field_answer: extracted.campaign_field_answer,
  };

  const nextStep = getNextStep(merged, signals);
  const patch = getCardPatchForStep(nextStep, merged, signals);
  const finalCard: ClientCard = { ...merged, ...patch };

  const campaignRoutingNow = finalCard.campaign_id ? routeCampaign(finalCard, signals) : null;

  const responderLastMessage =
    clientMessage ?? (opts.hasPhoto ? '[клиент прислал фото]' : null);

  const reply = await runResponder({
    nextStep,
    clientCard: finalCard,
    lastClientMessage: responderLastMessage,
    recentHistory: history,
    slotsDisplay: opts.slotsDisplay ?? null,
    campaign: campaignRoutingNow?.campaign ?? null,
    campaignPendingField: campaignRoutingNow?.pendingField ?? null,
  });

  const newHistory: RecentDialogTurn[] = [
    ...history,
    ...(clientMessage ? [{ from: 'client' as const, text: clientMessage }] : []),
    { from: 'inka' as const, text: reply },
  ];

  return { card: finalCard, nextStep, reply, history: newHistory, extracted };
}

function logTurn(clientMessage: string | null, outcome: TurnOutcome) {
  console.log(`  клиент: "${clientMessage ?? '[/start color_texture]'}"`);
  console.log(`  Инка (${outcome.nextStep}): ${outcome.reply}`);
  console.log('');
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY не задан в окружении — без него Extractor/Responder не могут вызвать OpenAI.');
    process.exit(1);
  }

  console.log('========================================');
  console.log('CAMPAIGN DIALOG EVAL — color_texture (self_book_slot)');
  console.log('========================================\n');

  let card = activateCampaign(freshCard(), 'color_texture');
  let history: RecentDialogTurn[] = [];

  // Ход 1: deep link — нет текста клиента, это триггер /start.
  let t = await runTurn(card, history, null);
  logTurn(null, t);
  check('ход 1: campaign_intro (не ask_idea, не quote_price)', t.nextStep === 'campaign_intro');
  card = t.card; history = t.history;

  // Ход 2: отвечает на место.
  t = await runTurn(card, history, 'о, интересно! на предплечье можно');
  logTurn('о, интересно! на предплечье можно', t);
  check('ход 2: placement реально записан', !!card.campaign_collected); // предварительно, уточним ниже
  check('ход 2: placement записан именно из этого сообщения', !!t.card.campaign_collected?.placement);
  card = t.card; history = t.history;

  // Ход 3: отвечает на размер.
  t = await runTurn(card, history, 'сантиметров 10-12 где-то, не больше');
  logTurn('сантиметров 10-12 где-то, не больше', t);
  check('ход 3: approximate_size записан', !!t.card.campaign_collected?.approximate_size);
  check('ход 3: это НЕ handoff/слоты — осталось фото', t.nextStep !== 'campaign_handoff' && t.nextStep !== 'campaign_show_slots');
  card = t.card; history = t.history;

  // Ход 4: уходит от темы на вопрос про деньги — ПРОВЕРКА: Responder не
  // называет точную сумму (campaign.payment.amount=null), и обязательное
  // поле (фото) не продвигается вопросом не по теме.
  t = await runTurn(card, history, 'а точно только расходники, не будет ещё какая-то доп. плата конкретно?');
  logTurn('а точно только расходники, не будет ещё какая-то доп. плата конкретно?', t);
  check('ход 4: Responder НЕ называет конкретную сумму в шекелях', !/\d+\s*₪/.test(t.reply));
  check('ход 4: фото всё ещё не засчитано (вопрос не по теме)', t.card.campaign_collected?.photo_of_placement === undefined);
  card = t.card; history = t.history;

  // Ход 5: прямая просьба пропустить обязательное фото — ПРОВЕРКА:
  // required-поле не разрешает пропуск (в отличие от optional_info).
  t = await runTurn(card, history, 'можно без фото? мне неудобно фотографировать это место');
  logTurn('можно без фото? мне неудобно фотографировать это место', t);
  check('ход 5: фото всё ещё НЕ засчитано — просьба пропустить не прошла', t.card.campaign_collected?.photo_of_placement === undefined);
  check('ход 5: шаг всё ещё про фото, не слоты/handoff', t.nextStep === 'campaign_ask_field');
  card = t.card; history = t.history;

  // Ход 6: клиент говорит, что прислал фото (без реального файла — see
  // ограничение в шапке). Интересно посмотреть, учтёт ли Extractor
  // отсутствие настоящего вижн-контента или слепо поверит caption+флагу.
  t = await runTurn(card, history, 'вот, отправила', { hasPhoto: true, photoCaption: 'вот фото' });
  logTurn('вот, отправила [фото]', t);
  console.log(`    (живой Extractor на эту реплику с hasPhoto=true, без реального файла: campaign_field_answer=${JSON.stringify(t.extracted.campaign_field_answer)})`);
  card = t.card; history = t.history;

  // Если даже без настоящего вижн-контента поле не засчиталось — это
  // ОЖИДАЕМО честное поведение (см. ограничение скрипта), а не баг.
  // Подставляем реальный ответ вручную, чтобы продолжить диалог дальше —
  // ровно так же легитимно, как детерминированный тест симулирует
  // Extractor, см. test/campaignClientJourney.ts.
  if (card.campaign_collected?.photo_of_placement === undefined) {
    console.log('    [нет настоящего файла фото — подставляем принятый ответ вручную, чтобы продолжить диалог]');
    card = applyCampaignAnswer(card, 'photo_of_placement', 'yes');
  }

  // Ход 7: все обязательные поля собраны — должен решить, что дальше
  // (self_book_slot → слоты). Подставляем две свежих "времени" из
  // отдельного пула [КАМПЕЙН], как это бы сделал реальный getAvailableSlots.
  const slotsDisplay = ['вторник, 12 мая, 15:00', 'среда, 13 мая, 11:00'];
  card = { ...card, slot_options: ['ev1', 'ev2'] };
  let routing = routeCampaign(card);
  check('после фото: required_info полностью собран → campaign_show_slots', routing?.step === 'campaign_show_slots');
  let patch = getCardPatchForStep('campaign_show_slots', card, { is_admin_sender: false, is_prompt_injection: false, is_out_of_scope: false, is_wrong_layout: false, client_picked_slot_id: null, client_wants_other_slots: false, client_asks_for_more_slots: false, client_wants_to_reschedule: false, client_confirms_booking: null, campaign_field_answer: null });
  card = { ...card, ...patch };
  const replyShowSlots = await runResponder({
    nextStep: 'campaign_show_slots',
    clientCard: card,
    lastClientMessage: null,
    recentHistory: history,
    slotsDisplay,
    campaign: routing!.campaign,
    campaignPendingField: null,
  });
  console.log(`  Инка (campaign_show_slots): ${replyShowSlots}`);
  console.log('');
  history = [...history, { from: 'inka', text: replyShowSlots }];

  // Ход 8: клиент выбирает второе время.
  t = await runTurn(card, history, 'второе время, пожалуйста', { slotsDisplay });
  logTurn('второе время, пожалуйста', t);
  check('ход 8: валидный выбор → campaign_confirm_slot', t.nextStep === 'campaign_confirm_slot');
  card = t.card; history = t.history;

  // Симулируем реальную бронь (bookSlot в pages/api/telegram.ts) — без сети.
  card = { ...card, chosen_slot_id: 'ev2', booked_slot_display: 'среда, 13 мая, 11:00' };
  patch = getCardPatchForStep('campaign_confirm_slot', card, { is_admin_sender: false, is_prompt_injection: false, is_out_of_scope: false, is_wrong_layout: false, client_picked_slot_id: 'ev2', client_wants_other_slots: false, client_asks_for_more_slots: false, client_wants_to_reschedule: false, client_confirms_booking: null, campaign_field_answer: null });
  card = { ...card, ...patch };
  const routingConfirmed = routeCampaign(card);
  const replyConfirm = await runResponder({
    nextStep: 'campaign_confirm_slot',
    clientCard: card,
    lastClientMessage: 'второе время, пожалуйста',
    recentHistory: history,
    slotsDisplay,
    campaign: routingConfirmed?.campaign ?? null,
    campaignPendingField: null,
  });
  console.log(`  Инка (campaign_confirm_slot): ${replyConfirm}`);
  check('ход 9: НЕ обещает финальное принятие ("ты принята"/"ты модель")', !/ты\s+(точно\s+)?прин|ты\s+модель/i.test(replyConfirm));
  check('ход 9: нет реквизитов предоплаты (этой кампании они не нужны)', !/реквизит|предоплат/i.test(replyConfirm));
  console.log('');
  history = [...history, { from: 'client', text: 'второе время, пожалуйста' }, { from: 'inka', text: replyConfirm }];

  // Ход 10: клиент пишет после брони — проверка followup, не повтор анкеты.
  t = await runTurn(card, history, 'хорошо, спасибо! жду');
  logTurn('хорошо, спасибо! жду', t);
  check('ход 10: campaign_followup_chat (не переспрашивает анкету/слоты)', t.nextStep === 'campaign_followup_chat');

  console.log('========================================');
  console.log(anyProblem ? 'ИТОГО: есть проблемы — см. FAIL выше.' : 'ИТОГО: все проверки прошли.');
  console.log('========================================');
  if (anyProblem) process.exit(1);
}

main();
