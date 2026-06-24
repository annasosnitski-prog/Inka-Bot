// ============================================================
// INKA-BOT — Calendar
// Работа с Google Calendar по принципу из мастер-промпта:
// "два типа слотов: [КОНС] и [ТАТУ]. мастер ставит их сама."
//
// Мастер ВРУЧНУЮ создаёт события с тегом [КОНС] или [ТАТУ] в начале
// названия — это и есть способ выставить свободный слот. Бот НЕ
// генерирует и не вычисляет время сам. Он только:
//   1. ищет такие события без маркера занятости в названии
//      (getAvailableSlots) — это будущие slot_options;
//   2. при выборе клиентом — переименовывает то же событие, добавляя
//      маркер занятости (bookSlot) — событие выходит из пула свободных.
//
// Аутентификация: JWT service account, прямой REST-вызов (без пакета
// googleapis — легче и предсказуемее в серверless-среде Vercel).
// ============================================================

const CALENDAR_ID =
  '5e40406c76b8c676638fea6ef53cd3207a2ec754c6d0c5113d04a1a52d5c820d@group.calendar.google.com';

const SLOT_TAG = {
  consultation: '[КОНС]',
  tattoo: '[ТАТУ]',
} as const;

export type SlotType = keyof typeof SLOT_TAG; // 'consultation' | 'tattoo'

// Маркеры занятости — если они уже есть в названии события, слот
// считается занятым и не попадает в свободные.
const BUSY_MARKERS = ['ОЖИДАЕТ ПРЕДОПЛАТЫ', 'КОНС ОНЛАЙН', 'ЗАНЯТО'];

export interface AvailableSlot {
  id: string; // Google Calendar event id — это и есть slot id для ClientCard.slot_options
  summary: string; // полное название события, как есть в календаре
  start: string; // ISO datetime
  end: string; // ISO datetime
}

// ----------------------------------------------------------
// АУТЕНТИФИКАЦИЯ — JWT service account, получаем access_token
// ----------------------------------------------------------

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  // Кэшируем токен на время жизни serverless-инстанса — Google токены
  // живут 1 час, нет смысла запрашивать новый на каждый вызов.
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY;

  if (!email || !rawKey) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY not set');
  }

  // В Vercel env vars ключ хранится с буквальными "\n" внутри строки —
  // превращаем их в настоящие переводы строки для подписи JWT.
  const privateKey = rawKey.replace(/\\n/g, '\n');

  const jwt = await buildSignedJwt(email, privateKey);

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Google OAuth token request failed: ${response.status} ${errText}`);
  }

  const data = await response.json();
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return cachedToken.token;
}

// Строит и подписывает JWT для service account (RS256), используя
// встроенный Node.js crypto — без внешних библиотек.
async function buildSignedJwt(email: string, privateKey: string): Promise<string> {
  const crypto = await import('crypto');

  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claimSet = {
    iss: email,
    scope: 'https://www.googleapis.com/auth/calendar',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const base64url = (input: string) =>
    Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedClaimSet = base64url(JSON.stringify(claimSet));
  const signingInput = `${encodedHeader}.${encodedClaimSet}`;

  const signature = crypto
    .createSign('RSA-SHA256')
    .update(signingInput)
    .sign(privateKey, 'base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return `${signingInput}.${signature}`;
}

// ----------------------------------------------------------
// ПОИСК СВОБОДНЫХ СЛОТОВ
// ----------------------------------------------------------

export async function getAvailableSlots(type: SlotType, maxResults = 3): Promise<AvailableSlot[]> {
  const token = await getAccessToken();
  const tag = SLOT_TAG[type];

  // Ищем события начиная с текущего момента — прошедшие слоты не
  // интересны. q= ищет по тексту события (название), Google Calendar
  // API делает это как полнотекстовый поиск, дальше дофильтровываем
  // точным совпадением тега в начале названия и отсутствием маркеров
  // занятости — сам API может зацепить лишнее по нечёткому совпадению.
  const params = new URLSearchParams({
    timeMin: new Date().toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    q: tag,
    maxResults: '50', // берём с запасом, точная фильтрация — ниже кодом
  });

  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
    CALENDAR_ID
  )}/events?${params.toString()}`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Calendar events.list failed: ${response.status} ${errText}`);
  }

  const data = await response.json();
  const items: any[] = data.items ?? [];

  const freeSlots: AvailableSlot[] = items
    .filter((event) => {
      const summary: string = event.summary ?? '';
      const startsWithTag = summary.trim().startsWith(tag);
      const isBusy = BUSY_MARKERS.some((marker) => summary.includes(marker));
      return startsWithTag && !isBusy;
    })
    .map((event) => ({
      id: event.id,
      summary: event.summary,
      start: event.start?.dateTime ?? event.start?.date,
      end: event.end?.dateTime ?? event.end?.date,
    }))
    .slice(0, maxResults);

  return freeSlots;
}

// ----------------------------------------------------------
// БРОНИРОВАНИЕ — переименовать событие, помечая его занятым
// ----------------------------------------------------------

export interface BookSlotResult {
  success: boolean;
  newSummary?: string;
  error?: string;
}

export async function bookSlot(
  eventId: string,
  type: SlotType,
  clientLabel: string // например имя клиента или username, для [КОНС]
): Promise<BookSlotResult> {
  const token = await getAccessToken();

  // 1. Получить текущее событие — нужно текущее summary, чтобы
  // дописать маркер занятости, а не потерять остальной текст
  // (например время/детали, которые мастер могла вписать в title).
  const getUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
    CALENDAR_ID
  )}/events/${encodeURIComponent(eventId)}`;

  const getResponse = await fetch(getUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!getResponse.ok) {
    const errText = await getResponse.text();
    return { success: false, error: `Calendar events.get failed: ${getResponse.status} ${errText}` };
  }

  const event = await getResponse.json();
  const currentSummary: string = event.summary ?? '';

  // Защита: если событие УЖЕ занято (кто-то успел забронировать между
  // показом слотов и выбором) — не перезаписываем, сообщаем об этом.
  const alreadyBusy = BUSY_MARKERS.some((marker) => currentSummary.includes(marker));
  if (alreadyBusy) {
    return { success: false, error: 'SLOT_ALREADY_BOOKED' };
  }

  const marker = type === 'tattoo' ? 'ОЖИДАЕТ ПРЕДОПЛАТЫ' : `КОНС ОНЛАЙН ${clientLabel}`;
  const newSummary = `${currentSummary} — ${marker}`;

  const patchUrl = getUrl;
  const patchResponse = await fetch(patchUrl, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ summary: newSummary }),
  });

  if (!patchResponse.ok) {
    const errText = await patchResponse.text();
    return { success: false, error: `Calendar events.patch failed: ${patchResponse.status} ${errText}` };
  }

  return { success: true, newSummary };
}
