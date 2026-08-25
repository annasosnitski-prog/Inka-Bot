// ============================================================
// INKA-BOT — чистая логика временных окон для cron-напоминаний
// (pages/api/payment-reminders.ts, warm-lead-reminders.ts,
// waiting-list-check.ts). Вынесена отдельно от самих роутов, чтобы
// границы окон и приоритет тату/консультация можно было покрыть
// юнит-тестами (test/selftest.ts) — сами роуты завязаны на сеть
// (Airtable/Telegram/Google Calendar) и напрямую не тестируются, как
// и остальной код в pages/api/*.ts в этом проекте.
// ============================================================

// ПОЗДНЕЕ окно напоминания об оплате — до слота осталось не больше
// windowHours, но слот ещё не наступил.
export function shouldSendLatePaymentReminder(hoursRemaining: number, windowHours: number): boolean {
  return hoursRemaining > 0 && hoursRemaining <= windowHours;
}

// РАННЕЕ окно напоминания об оплате — с момента брони прошло не меньше
// earlyWindowHours, а до слота ЕЩЁ ДАЛЕКО (за пределами позднего окна —
// иначе это его зона, не дублируем). hoursRemaining = null, если у
// клиента почему-то нет booked_slot_start_iso (не должно случаться для
// реальной тату-брони, но не должно и падать) — в этом случае позднее
// окно неприменимо, раннее срабатывает по одному лишь hoursSinceBooked.
export function shouldSendEarlyPaymentReminder(
  hoursSinceBooked: number,
  earlyWindowHours: number,
  hoursRemaining: number | null,
  lateWindowHours: number
): boolean {
  if (hoursSinceBooked < earlyWindowHours) return false;
  if (hoursRemaining !== null && hoursRemaining <= lateWindowHours) return false;
  return true;
}

// Тёплый лид, увидевший цену и не ответивший да/нет на "хочешь
// записаться?", молчит не меньше windowHours.
export function shouldSendWarmLeadReminder(hoursSilent: number, windowHours: number): boolean {
  return hoursSilent >= windowHours;
}

export type WaitingListSlotType = 'tattoo' | 'consultation' | null;

// Какой тип слота нужен клиенту в листе ожидания — прямой приоритет
// тату над консультацией, как и везде в state machine (см.
// lib/stateMachine.ts, п. 11a/11b).
export function pickWaitingListSlotType(
  directTattooAllowed: unknown,
  consultationNeeded: unknown
): WaitingListSlotType {
  if (directTattooAllowed === 'yes') return 'tattoo';
  if (consultationNeeded === 'yes') return 'consultation';
  return null;
}
