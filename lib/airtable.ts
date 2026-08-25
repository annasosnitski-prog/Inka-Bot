const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN!;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID!;
const AIRTABLE_TABLE_ID = process.env.AIRTABLE_TABLE_ID!;

console.log('AIRTABLE env check:', {
  tokenPresent: !!AIRTABLE_TOKEN,
  tokenLength: AIRTABLE_TOKEN ? AIRTABLE_TOKEN.length : 0,
  baseId: AIRTABLE_BASE_ID,
  tableId: AIRTABLE_TABLE_ID,
});

const AIRTABLE_API_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_ID}`;

export interface ClientRecord {
  id: string;
  fields: Record<string, any>;
}

export async function findClientByTelegramId(
  telegramId: number | string
): Promise<ClientRecord | null> {
  const formula = encodeURIComponent(`{telegram_id} = ${Number(telegramId)}`);
  const url = `${AIRTABLE_API_URL}?filterByFormula=${formula}&maxRecords=1`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
  });

  if (!res.ok) {
    throw new Error(`Airtable search failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  if (!data.records || data.records.length === 0) {
    return null;
  }
  return data.records[0];
}

// Поиск клиента по имени или @username — для admin-режима, когда Аня
// указывает клиента текстом, а не пересылкой. Регистронезависимо, по
// подстроке. Может вернуть несколько (тёзки) — вызывающий код решает,
// что делать с неоднозначностью.
export async function findClientsByName(query: string): Promise<ClientRecord[]> {
  // Чистим ввод: убираем ведущий @ и кавычки (последние сломали бы
  // формулу Airtable). Пустой запрос — ничего не ищем.
  const q = query.trim().replace(/^@+/, '').replace(/["']/g, '').toLowerCase();
  if (!q) return [];

  // FIND(needle, haystack) возвращает позицию (>0) при совпадении.
  // Ищем и в name, и в username. Double-quotes в формуле — чтобы
  // апострофы в именах не ломали синтаксис (кавычки из q уже убраны).
  const formula = `OR(FIND("${q}", LOWER({name})), FIND("${q}", LOWER({username})))`;
  const url = `${AIRTABLE_API_URL}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=5`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
  });

  if (!res.ok) {
    throw new Error(`Airtable name search failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return data.records ?? [];
}

// Клиенты с тату-бронью, за которую ещё не пришла предоплата и по которой
// мастеру ещё не отправлялось напоминание — источник для cron-джобы
// /api/payment-reminders (шаг 6 #4). Именно deposit_status = "waiting_prepayment"
// (не waiting_confirmation) — если клиент уже прислал скрин, это её забота
// подтвердить оплату, а не напоминание "клиент ничего не прислал".
export async function findClientsAwaitingPayment(): Promise<ClientRecord[]> {
  const formula =
    `AND({deposit_status} = "waiting_prepayment", {payment_reminder_sent} != "yes", {booked_slot_start_iso} != "")`;
  const url = `${AIRTABLE_API_URL}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=100`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
  });

  if (!res.ok) {
    throw new Error(`Airtable payment-reminder search failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return data.records ?? [];
}

// Клиенты с тату-бронью, ожидающей предоплаты — та же выборка, что и
// findClientsAwaitingPayment (deposit_status = "waiting_prepayment"), но БЕЗ
// фильтра по payment_reminder_sent — источник для РАННЕГО окна напоминания
// (см. pages/api/payment-reminders.ts), у которого свой отдельный гвард
// payment_reminder_early_sent, не связанный с поздним (≤36ч до слота).
// Фильтруем по booked_at, а не booked_slot_start_iso — раннее напоминание
// считает время С МОМЕНТА БРОНИ, не время ДО слота.
export async function findClientsAwaitingPaymentEarly(): Promise<ClientRecord[]> {
  const formula =
    `AND({deposit_status} = "waiting_prepayment", {payment_reminder_early_sent} != "yes", {booked_at} != "")`;
  const url = `${AIRTABLE_API_URL}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=100`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
  });

  if (!res.ok) {
    throw new Error(`Airtable early-payment-reminder search failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return data.records ?? [];
}

// Клиенты, которым уже показали цену, но которые ещё не ответили да/нет на
// "хочешь записаться?" (wants_to_book пусто) — источник для cron-джобы
// /api/warm-lead-reminders. lead_status = "new" отсекает тех, кто уже ушёл
// дальше по воронке (slots_shown/booked/waiting_slots/blocked) — до этих
// шагов lead_status ничем, кроме "new", не бывает выставлен (см.
// lib/stateMachine.ts — 'diagnosing'/'estimated'/'wants_booking' в коде
// нигде не присваиваются, это зарезервированные, но пока неиспользуемые
// значения типа).
export async function findSilentQuotedLeads(): Promise<ClientRecord[]> {
  const formula =
    `AND({price_shown} = "yes", {wants_to_book} = "", {lead_status} = "new", {warm_lead_reminder_sent} != "yes")`;
  const url = `${AIRTABLE_API_URL}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=100`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
  });

  if (!res.ok) {
    throw new Error(`Airtable silent-lead search failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return data.records ?? [];
}

// Клиенты в листе ожидания слотов (тату ИЛИ консультация) — источник для
// cron-джобы /api/waiting-list-check, которая сама проверяет календарь и,
// если появились варианты, пишет клиенту напрямую, не дожидаясь, пока он
// снова напишет сам (раньше это работало только реактивно — см. state
// machine п. 5b, isWaitingForSlots).
export async function findClientsWaitingForSlots(): Promise<ClientRecord[]> {
  const formula = `OR({lead_status} = "waiting_slots", {lead_status} = "waiting_slots_pinged")`;
  const url = `${AIRTABLE_API_URL}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=100`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
  });

  if (!res.ok) {
    throw new Error(`Airtable waiting-list search failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return data.records ?? [];
}

export async function createClient(fields: Record<string, any>): Promise<ClientRecord> {
  const res = await fetch(AIRTABLE_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields, typecast: true }),
  });

  if (!res.ok) {
    throw new Error(`Airtable create failed: ${res.status} ${await res.text()}`);
  }

  return res.json();
}

export async function updateClient(
  recordId: string,
  fields: Record<string, any>
): Promise<ClientRecord> {
  const url = `${AIRTABLE_API_URL}/${recordId}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields, typecast: true }),
  });

  if (!res.ok) {
    throw new Error(`Airtable update failed: ${res.status} ${await res.text()}`);
  }

  return res.json();
}

export async function upsertClient(
  telegramId: number | string,
  commonFields: Record<string, any>,
  createOnlyFields: Record<string, any> = {}
): Promise<{ record: ClientRecord; isNew: boolean }> {
  const existing = await findClientByTelegramId(telegramId);

  if (existing) {
    const updated = await updateClient(existing.id, commonFields);
    return { record: updated, isNew: false };
  }

  const created = await createClient({
    telegram_id: Number(telegramId),
    ...commonFields,
    ...createOnlyFields,
  });
  return { record: created, isNew: true };
}
