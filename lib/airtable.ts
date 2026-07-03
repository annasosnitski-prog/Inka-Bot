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
