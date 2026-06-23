const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN!;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID!;
const AIRTABLE_TABLE_ID = process.env.AIRTABLE_TABLE_ID!;

const AIRTABLE_API_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_ID}`;

export interface ClientRecord {
  id: string;
  fields: Record<string, any>;
}

export async function findClientByTelegramId(
  telegramId: number | string
): Promise<ClientRecord | null> {
  const formula = encodeURIComponent(`{telegram_id} = '${telegramId}'`);
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

export async function createClient(fields: Record<string, any>): Promise<ClientRecord> {
  const res = await fetch(AIRTABLE_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
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
    body: JSON.stringify({ fields }),
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
    telegram_id: String(telegramId),
    ...commonFields,
    ...createOnlyFields,
  });
  return { record: created, isNew: true };
}
