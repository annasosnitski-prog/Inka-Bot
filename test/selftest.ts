// ============================================================
// INKA-BOT — self-test (детерминированная логика, без сети/LLM)
// Прогоняет "мозг" бота: state machine, патчи состояния, форматирование
// расписания/счёта и блок реквизитов. НЕ проверяет качество формулировок
// LLM и не ходит в Telegram/Airtable/Calendar — только чистую логику,
// где живут настоящие баги.
//
// Запуск:
//   npx tsc test/selftest.ts --outDir /tmp/inka-test --module commonjs \
//     --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck
//   node /tmp/inka-test/test/selftest.js
// ============================================================

import {
  getNextStep,
  getCardPatchForStep,
  type ClientCard,
  type MessageSignals,
  type NextStep,
} from '../lib/stateMachine';
import {
  formatSchedule,
  type ScheduleEvent,
  diaryEventId,
  buildDiaryEventSummary,
  buildDiaryEventDescription,
  computeEndNaive,
  tagsForRequest,
  tagOf,
  tagDisplayLabel,
  busyMarkerForTag,
  formatSlotForDisplay,
  isBotBooking,
  type AvailableSlot,
} from '../lib/calendar';
import { formatInvoice, isScheduleRequest } from '../lib/admin';
import { buildMirrorText } from '../lib/dialogLog';
import { parseAddSlotCommand } from '../lib/addSlotParser';
import { buildPaymentDetailsBlock } from '../pages/api/telegram';

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

// ---- фабрики ----
function baseCard(over: Partial<ClientCard> = {}): ClientCard {
  return {
    telegram_id: 1, intent: 'booking', lead_status: 'estimated', category: 'small',
    idea: 'роза', size: '10см', placement: 'предплечье', first_tattoo: 'yes',
    existing_tattoo: 'no', direct_tattoo_allowed: 'yes', consultation_needed: 'no',
    active_work_time_estimate: '<=3h', price_quoted: '800₪', price_explained: 'yes',
    wants_to_book: 'yes', contact_preference: null, contact_value: null, phone: null,
    payment_status: null, client_type: '2_reference', skin_notes: null, spam_count: 0,
    chosen_slot_id: null, slot_options: ['ev1', 'ev2'], booked_slot_display: null,
    booked_slot_start_iso: null, payment_reminder_sent: null, photos_count: 0,
    has_photo_this_message: false, photo_has_caption: false, force_client_mode: null,
    ...over,
  };
}
function sig(over: Partial<MessageSignals> = {}): MessageSignals {
  return {
    is_admin_sender: false, is_prompt_injection: false, is_out_of_scope: false,
    is_wrong_layout: false,
    client_picked_slot_id: null, client_wants_other_slots: false,
    client_asks_for_more_slots: false, client_wants_to_reschedule: false,
    client_confirms_booking: null, ...over,
  };
}
const step = (c: Partial<ClientCard>, s: Partial<MessageSignals> = {}): NextStep =>
  getNextStep(baseCard(c), sig(s));

// ================= STATE MACHINE =================
console.log('\n▶ getNextStep — booking flow & phone gate');
eq('tattoo без телефона → ask_phone', step({}), 'ask_phone');
eq('tattoo с телефоном → show_tattoo_slots', step({ phone: '0501112233' }), 'show_tattoo_slots');
eq('консультация без телефона → ask_phone',
  step({ direct_tattoo_allowed: 'no', consultation_needed: 'yes', category: 'large' }), 'ask_phone');
eq('консультация с телефоном → show_consultation_slots',
  step({ direct_tattoo_allowed: 'no', consultation_needed: 'yes', category: 'large', phone: '05011' }),
  'show_consultation_slots');
eq('нет цены → quote_price', step({ price_quoted: null, price_explained: null }), 'quote_price');
eq('цена есть, wants_to_book null → ask_wants_to_book',
  step({ wants_to_book: null }), 'ask_wants_to_book');
eq('явный отказ → all_done', step({ wants_to_book: 'no' }), 'all_done');
eq('первое тату неизвестно → ask_first_tattoo',
  step({ phone: '05011', first_tattoo: null }), 'ask_first_tattoo');

console.log('\n▶ getNextStep — slots shown');
eq('валидный выбор + телефон → confirm_slot_awaiting_payment',
  step({ lead_status: 'slots_shown', phone: '05011' }, { client_picked_slot_id: 'ev1' }),
  'confirm_slot_awaiting_payment');
eq('выбор устаревшего слота → slot_taken_pick_again',
  step({ lead_status: 'slots_shown', phone: '05011' }, { client_picked_slot_id: 'ghost' }),
  'slot_taken_pick_again');
eq('непонятный ответ на слоты → unclear_slot_choice',
  step({ lead_status: 'slots_shown', phone: '05011' }), 'unclear_slot_choice');
eq('просит другие слоты → slot_change_requested_waiting',
  step({ lead_status: 'slots_shown', phone: '05011' }, { client_wants_other_slots: true }),
  'slot_change_requested_waiting');

console.log('\n▶ getNextStep — booked & payment & edge order');
eq('скрин предоплаты → payment_screenshot_received',
  step({ lead_status: 'tattoo_booked_waiting_payment', payment_status: 'waiting_prepayment', has_photo_this_message: true }),
  'payment_screenshot_received');
eq('повторный скрин (guard) → booked_followup_chat',
  step({ lead_status: 'tattoo_booked_waiting_payment', payment_status: 'waiting_confirmation', has_photo_this_message: true }),
  'booked_followup_chat');
eq('фото без подписи ДО брони → handle_photo_no_caption',
  step({ lead_status: 'diagnosing', idea: null, has_photo_this_message: true, photo_has_caption: false }),
  'handle_photo_no_caption');
eq('вопрос после брони → booked_followup_chat',
  step({ lead_status: 'consultation_booked' }), 'booked_followup_chat');
eq('перенос после брони → reschedule_requested_ping_master',
  step({ lead_status: 'consultation_booked' }, { client_wants_to_reschedule: true }),
  'reschedule_requested_ping_master');
eq('неправильная раскладка → wrong_keyboard_layout',
  step({ idea: null }, { is_wrong_layout: true }), 'wrong_keyboard_layout');
eq('раскладка не перебивает блокировку',
  step({ lead_status: 'blocked' }, { is_wrong_layout: true }), 'silence_blocked');
eq('заблокирован → silence_blocked', step({ lead_status: 'blocked' }), 'silence_blocked');
eq('админ → admin_mode', step({}, { is_admin_sender: true }), 'admin_mode');
eq('админ в режиме /client → обычная воронка (не admin_mode)',
  step({ force_client_mode: 'yes', phone: '05011' }, { is_admin_sender: true }), 'show_tattoo_slots');

// ================= PATCHES =================
console.log('\n▶ getCardPatchForStep');
const p1 = getCardPatchForStep('confirm_slot_awaiting_payment', baseCard(), sig());
ok('confirm тату: lead_status', p1.lead_status === 'tattoo_booked_waiting_payment');
ok('confirm тату: deposit waiting_prepayment', p1.payment_status === 'waiting_prepayment');
ok('confirm тату: slot_options обнулён', p1.slot_options === null);
const p2 = getCardPatchForStep('payment_screenshot_received', baseCard(), sig());
ok('скрин: deposit waiting_confirmation', p2.payment_status === 'waiting_confirmation');
ok('скрин: lead_status НЕ трогается', p2.lead_status === undefined);
const p3 = getCardPatchForStep('show_tattoo_slots', baseCard(), sig());
ok('показ слотов: lead_status slots_shown', p3.lead_status === 'slots_shown');

// ================= FORMATTERS =================
console.log('\n▶ formatSchedule');
const evs: ScheduleEvent[] = [
  { id: '1', summary: '[ТАТУ] окно', start: '2026-07-03T15:00:00+03:00', end: '2026-07-03T18:00:00+03:00', isBusy: false, type: 'tattoo', allDay: false },
  { id: '2', summary: '[ТАТУ] — ОЖИДАЕТ ПРЕДОПЛАТЫ', start: '2026-07-03T19:00:00+03:00', end: '2026-07-03T21:00:00+03:00', isBusy: true, type: 'tattoo', allDay: false },
];
const sched = formatSchedule(evs);
ok('расписание: есть день', sched.includes('пятница'));
ok('расписание: 🟢 свободный', sched.includes('🟢 15:00'));
ok('расписание: 🔴 занятый', sched.includes('🔴 19:00'));
ok('расписание: пусто', formatSchedule([]).includes('пусто'));

console.log('\n▶ formatInvoice');
const inv = formatInvoice({ name: 'Маша', username: 'masha', phone: '0501112233', idea: 'роза', price_quoted: '800₪', deposit_status: 'waiting_confirmation', lead_status: 'tattoo_booked_waiting_payment' });
ok('счёт: имя+username', inv.includes('Маша') && inv.includes('@masha'));
ok('счёт: телефон', inv.includes('0501112233'));
ok('счёт: цена', inv.includes('800₪'));
ok('счёт: депозит расшифрован', inv.includes('нужно подтвердить'));
ok('счёт: статус расшифрован', inv.includes('ждёт предоплату'));

console.log('\n▶ isScheduleRequest (естественные фразы про расписание)');
ok('«что по записям» → true', isScheduleRequest('что по записям'));
ok('«какие записи сегодня» → true', isScheduleRequest('какие записи сегодня'));
ok('«покажи календарь» → true', isScheduleRequest('покажи календарь'));
ok('«покажи расписание» → true', isScheduleRequest('покажи расписание'));
ok('«что там с Машей» → false (не расписание)', !isScheduleRequest('что там с Машей'));
ok('«как дела» → false', !isScheduleRequest('как дела'));

console.log('\n▶ buildMirrorText (лог живого диалога)');
eq('оба есть → 👤+🤖 через пустую строку',
  buildMirrorText('хочу тату', 'супер, расскажи подробнее'),
  '👤 хочу тату\n\n🤖 супер, расскажи подробнее');
eq('только клиент (Инка ещё не ответила)',
  buildMirrorText('хочу тату', null), '👤 хочу тату');
eq('только Инка (silence_blocked — клиент промолчал)',
  buildMirrorText(null, 'привет!'), '🤖 привет!');
eq('оба пустые → null', buildMirrorText(null, null), null as any);

console.log('\n▶ parseAddSlotCommand (Шаг 3 — /добавить, детерминированный разбор)');
// "сейчас" зафиксировано на понедельник 13.07.2026, 13:00 Israel time
// (10:00 UTC, лето — UTC+3), чтобы тесты были воспроизводимы.
const NOW = new Date('2026-07-13T10:00:00Z');

function expectOk(name: string, text: string, want: { tag: string; date: string; startTime: string; endTime: string }) {
  const r = parseAddSlotCommand(text, NOW);
  ok(`${name}: ok`, r.ok === true, JSON.stringify(r));
  if (r.ok) {
    ok(`${name}: tag=${want.tag}`, r.tag === want.tag, r.tag);
    ok(`${name}: date=${want.date}`, r.date === want.date, r.date);
    ok(`${name}: time=${want.startTime}-${want.endTime}`, r.startTime === want.startTime && r.endTime === want.endTime, `${r.startTime}-${r.endTime}`);
  }
}
function expectFail(name: string, text: string) {
  const r = parseAddSlotCommand(text, NOW);
  ok(`${name}: fail`, r.ok === false, JSON.stringify(r));
}

expectOk('walkin пятница', 'walkin пятница 12:00-14:00', { tag: '[WALKIN]', date: '2026-07-17', startTime: '12:00', endTime: '14:00' });
expectOk('вокин через дефис', 'вок-ин пятница 12-14', { tag: '[WALKIN]', date: '2026-07-17', startTime: '12:00', endTime: '14:00' });
expectOk('конс завтра', 'конс завтра 10:00-10:30', { tag: '[КОНС]', date: '2026-07-14', startTime: '10:00', endTime: '10:30' });
expectOk('онлайн приоритетнее конс', 'консультация онлайн завтра 09:00-09:30', { tag: '[ONLINE]', date: '2026-07-14', startTime: '09:00', endTime: '09:30' });
expectOk('тату явная дата', 'тату 20.07 15:00-18:00', { tag: '[ТАТУ]', date: '2026-07-20', startTime: '15:00', endTime: '18:00' });
expectOk('тату дата словом', 'тату 20 июля 15:00-18:00', { tag: '[ТАТУ]', date: '2026-07-20', startTime: '15:00', endTime: '18:00' });
expectOk('сегодня = день недели (понедельник)', 'walkin понедельник 12:00-13:00', { tag: '[WALKIN]', date: '2026-07-13', startTime: '12:00', endTime: '13:00' });
expectOk('сегодня явно', 'конс сегодня 18:00-18:30', { tag: '[КОНС]', date: '2026-07-13', startTime: '18:00', endTime: '18:30' });
expectOk('послезавтра', 'тату послезавтра 11-12', { tag: '[ТАТУ]', date: '2026-07-15', startTime: '11:00', endTime: '12:00' });
expectOk('воскресенье (после пятницы)', 'онлайн воскресенье 09:00-09:20', { tag: '[ONLINE]', date: '2026-07-19', startTime: '09:00', endTime: '09:20' });
expectOk('«с 12 до 14»', 'walkin пятница с 12 до 14', { tag: '[WALKIN]', date: '2026-07-17', startTime: '12:00', endTime: '14:00' });
expectOk('явная дата в прошлом года без года → следующий год', 'тату 01.01 10:00-11:00', { tag: '[ТАТУ]', date: '2027-01-01', startTime: '10:00', endTime: '11:00' });

// Регрессия на класс бага "\b не матчится с кириллицей" (см. коммит) —
// короткие 2-буквенные аббревиатуры дней недели остались непроверенными
// в первой версии тестов и не поймали баг сразу.
expectOk('короткая аббревиатура «вт» (вторник)', 'тату вт 09:00-10:00', { tag: '[ТАТУ]', date: '2026-07-14', startTime: '09:00', endTime: '10:00' });
expectOk('короткая аббревиатура «сб» (суббота)', 'конс сб 11:00-11:30', { tag: '[КОНС]', date: '2026-07-18', startTime: '11:00', endTime: '11:30' });
// "послезавтра" содержит подстроку "завтра" — не должно её перебивать.
expectOk('послезавтра не путается с завтра', 'walkin послезавтра 08:00-09:00', { tag: '[WALKIN]', date: '2026-07-15', startTime: '08:00', endTime: '09:00' });

expectFail('нет тега вообще', 'пятница 12:00-14:00');
expectFail('нет времени', 'walkin пятница');
expectFail('нет даты', 'walkin 12:00-14:00');
expectFail('конец раньше начала', 'walkin пятница 14:00-12:00');
expectFail('пустая строка', '');

console.log('\n▶ buildPaymentDetailsBlock');
delete process.env.PAYMENT_BIT; delete process.env.PAYMENT_BANK;
ok('нет env → null', buildPaymentDetailsBlock() === null);
process.env.PAYMENT_BIT = '050-123-4567';
process.env.PAYMENT_BANK = 'Hapoalim 12-345-678901';
const block = buildPaymentDetailsBlock() ?? '';
ok('блок: сумма 200₪', block.includes('200₪'));
ok('блок: Bit', block.includes('050-123-4567'));
ok('блок: банк', block.includes('Hapoalim 12-345-678901'));
ok('блок: просьба скрина', block.toLowerCase().includes('скрин'));

console.log('\n▶ 4 тега слотов — подбор / распознавание / маркеры');
// tagsForRequest: какие теги подходят под запрос
ok('большая тату → только [ТАТУ]',
  JSON.stringify(tagsForRequest('tattoo')) === JSON.stringify(['[ТАТУ]']));
ok('маленькая тату → [ТАТУ]+[WALKIN]',
  JSON.stringify(tagsForRequest('tattoo', { smallTattoo: true })) === JSON.stringify(['[ТАТУ]', '[WALKIN]']));
ok('конса → [КОНС]+[ONLINE]',
  JSON.stringify(tagsForRequest('consultation')) === JSON.stringify(['[КОНС]', '[ONLINE]']));
// tagOf: распознавание тега по названию события
eq('tagOf [WALKIN]', tagOf('[WALKIN] окно с 12'), '[WALKIN]');
eq('tagOf [ONLINE]', tagOf(' [ONLINE] вечер'), '[ONLINE]');
eq('tagOf личное событие → null', tagOf('зубной'), null as any);
eq('tagOf [КОНС ОНЛАЙН... ≠ [КОНС]', tagOf('[КОНС ОНЛАЙН] старое'), null as any);
// подписи формата для клиента
eq('label online', tagDisplayLabel('[ONLINE]'), ' (онлайн)');
eq('label конс', tagDisplayLabel('[КОНС]'), ' (в студии)');
eq('label walkin', tagDisplayLabel('[WALKIN]'), ' (walk-in)');
eq('label тату — пусто', tagDisplayLabel('[ТАТУ]'), '');
// formatSlotForDisplay дописывает пометку
const walkinSlot: AvailableSlot = { id: 'e1', summary: '[WALKIN] окно', start: '2026-07-17T12:00:00+03:00', end: '2026-07-17T14:00:00+03:00', tag: '[WALKIN]' };
ok('дисплей слота содержит (walk-in)', formatSlotForDisplay(walkinSlot).includes('(walk-in)'));
// busyMarkerForTag: маркер занятости по тегу
eq('бронь [ТАТУ] → ОЖИДАЕТ ПРЕДОПЛАТЫ', busyMarkerForTag('[ТАТУ]', 'tattoo'), 'ОЖИДАЕТ ПРЕДОПЛАТЫ');
eq('бронь [WALKIN] → ОЖИДАЕТ ПРЕДОПЛАТЫ', busyMarkerForTag('[WALKIN]', 'tattoo'), 'ОЖИДАЕТ ПРЕДОПЛАТЫ');
eq('бронь [ONLINE] → КОНС ОНЛАЙН', busyMarkerForTag('[ONLINE]', 'consultation'), 'КОНС ОНЛАЙН');
eq('бронь очной [КОНС] → КОНС ЗАПИСЬ', busyMarkerForTag('[КОНС]', 'consultation'), 'КОНС ЗАПИСЬ');

console.log('\n▶ diary sync — event id / summary / description / end time');
// diaryEventId: детерминированный, валидный для Google ([a-v0-9], 5+)
const id1 = diaryEventId('client-42-session-7');
const id2 = diaryEventId('client-42-session-7');
const id3 = diaryEventId('client-42-session-8');
ok('id детерминированный (тот же вход → тот же id)', id1 === id2);
ok('id разный для разных записей', id1 !== id3);
ok('id валиден для Google ([a-v0-9], 5+)', /^[a-v0-9]{5,}$/.test(id1));
// summary: тег в начале + ЗАНЯТО (чтобы не попасть в свободные слоты)
const sumT = buildDiaryEventSummary('tattoo', 'Мария', 'большая · старый клиент');
ok('summary тату начинается с [ТАТУ]', sumT.startsWith('[ТАТУ]'));
ok('summary содержит ЗАНЯТО', sumT.includes('ЗАНЯТО'));
ok('summary содержит имя и ярлык', sumT.includes('Мария') && sumT.includes('большая'));
const sumC = buildDiaryEventSummary('consultation', null, null);
ok('summary конс начинается с [КОНС]', sumC.startsWith('[КОНС]'));
ok('summary без имени/ярлыка не падает', sumC.includes('ЗАНЯТО'));
// description
const desc = buildDiaryEventDescription('Олег', 'новый клиент');
ok('описание помечено Дневником', desc.includes('Дневник'));
ok('описание содержит клиента и ярлык', desc.includes('Олег') && desc.includes('новый клиент'));
// computeEndNaive: wall-clock арифметика
eq('конец: 14:30 + 120 мин = 16:30', computeEndNaive('2026-07-08', '14:30', 120), '2026-07-08T16:30:00');
eq('конец: 23:30 + 60 мин = 00:30 след. дня', computeEndNaive('2026-07-08', '23:30', 60), '2026-07-09T00:30:00');

console.log('\n▶ isBotBooking — обратный поток в Дневник: бронь от бота vs своя из Дневника');
// Реальная бронь бота — любой тег, не только ONLINE/WALKIN.
ok('тату-бронь бота (через /добавить + клиент) — бот', isBotBooking('[ТАТУ] ОЖИДАЕТ ПРЕДОПЛАТЫ — Мария, +972501234567'));
ok('конс-бронь бота очная — бот', isBotBooking('[КОНС] КОНС ЗАПИСЬ — Олег'));
ok('онлайн-конс бота — бот', isBotBooking('[ONLINE] КОНС ОНЛАЙН — Оля'));
ok('walkin-бронь бота — бот', isBotBooking('[WALKIN] ОЖИДАЕТ ПРЕДОПЛАТЫ — Игорь'));
// Свои события из Дневника (маркер ЗАНЯТО) — не бронь бота, не дублируем обратно.
ok('тату из Дневника — не бронь бота', !isBotBooking(buildDiaryEventSummary('tattoo', 'Мария', 'большая')));
ok('конс из Дневника — не бронь бота', !isBotBooking(buildDiaryEventSummary('consultation', null, null)));
// Открытый пустой слот (ещё не бронь) и личные/чужие события — тоже нет.
ok('открытый пустой слот — не бронь', !isBotBooking('[КОНС]'));
ok('личное событие без тега — не бронь', !isBotBooking('Стоматолог 15:00'));
ok('пустая строка — не бронь', !isBotBooking(''));

// ================= ИТОГ =================
console.log(`\n${'='.repeat(40)}`);
console.log(`ИТОГО: ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));
process.exit(failed > 0 ? 1 : 0);
