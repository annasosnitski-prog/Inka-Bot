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

import { createHash } from 'crypto';

const CALENDAR_ID =
  '5e40406c76b8c676638fea6ef53cd3207a2ec754c6d0c5113d04a1a52d5c820d@group.calendar.google.com';

const SLOT_TAG = {
  consultation: '[КОНС]',
  tattoo: '[ТАТУ]',
} as const;

export type SlotType = keyof typeof SLOT_TAG; // 'consultation' | 'tattoo'

// ЧЕТЫРЕ вида тегов в календаре мастера. [КОНС]/[ТАТУ] — базовые (как в
// мастер-промпте), [ONLINE] — онлайн-консультация, [WALKIN] — окно для
// маленьких тату (до ~2ч). Правила бота (промпты, state machine) при
// добавлении ONLINE/WALKIN НЕ менялись — вся логика "какому клиенту какой
// тег" живёт здесь, в слое подбора слотов, на уже существующих полях
// карточки (category mini/small).
export type SlotTag = '[ТАТУ]' | '[КОНС]' | '[ONLINE]' | '[WALKIN]';
const ALL_TAGS: SlotTag[] = ['[ТАТУ]', '[КОНС]', '[ONLINE]', '[WALKIN]'];

// Какие теги подходят под запрос клиента. Walk-in добавляется к тату
// ТОЛЬКО когда работа маленькая (category mini/small — заведомо ≤2ч);
// консультация всегда предлагает оба формата — онлайн и в студии.
export function tagsForRequest(type: SlotType, opts?: { smallTattoo?: boolean }): SlotTag[] {
  if (type === 'tattoo') {
    return opts?.smallTattoo ? ['[ТАТУ]', '[WALKIN]'] : ['[ТАТУ]'];
  }
  return ['[КОНС]', '[ONLINE]'];
}

// Тег события по началу названия (или null — личное событие без тега).
export function tagOf(summary: string): SlotTag | null {
  const s = (summary ?? '').trim();
  return ALL_TAGS.find((t) => s.startsWith(t)) ?? null;
}

// Пометка формата для показа клиенту рядом с датой/временем. [ТАТУ] —
// без пометки (обычная запись, как раньше).
export function tagDisplayLabel(tag: SlotTag | null): string {
  switch (tag) {
    case '[ONLINE]':
      return ' (онлайн)';
    case '[КОНС]':
      return ' (в студии)';
    case '[WALKIN]':
      return ' (walk-in)';
    default:
      return '';
  }
}

// Маркер занятости при брони — зависит от ТЕГА слота, а не только от
// маршрута: онлайн-конса помечается как раньше ("КОНС ОНЛАЙН"), очная —
// новым маркером "КОНС ЗАПИСЬ", тату и walk-in ждут предоплату.
export function busyMarkerForTag(tag: SlotTag | null, type: SlotType): string {
  if (type === 'tattoo') return 'ОЖИДАЕТ ПРЕДОПЛАТЫ';
  return tag === '[КОНС]' ? 'КОНС ЗАПИСЬ' : 'КОНС ОНЛАЙН';
}

// Маркеры занятости — если они уже есть в названии события, слот
// считается занятым и не попадает в свободные.
const BUSY_MARKERS = ['ОЖИДАЕТ ПРЕДОПЛАТЫ', 'КОНС ОНЛАЙН', 'КОНС ЗАПИСЬ', 'ЗАНЯТО'];

// Маркер "ЗАНЯТО" — особый: им помечаются ТОЛЬКО события из Дневника
// (buildDiaryEventSummary), а не брони, которые оформил сам бот. Разница
// важна для обратного потока в Дневник (bot-bookings): бронь, которую
// сделал бот — независимо от тега [ТАТУ]/[КОНС]/[ONLINE]/[WALKIN] — это
// то, чего у мастера ещё нет в Дневнике и стоит показать. А её же
// собственные события из Дневника показывать ей обратно не нужно.
export function isBotBooking(summary: string): boolean {
  const s = summary ?? '';
  if (!tagOf(s)) return false;
  if (!BUSY_MARKERS.some((m) => s.includes(m))) return false;
  return !s.includes('ЗАНЯТО');
}

export interface AvailableSlot {
  id: string; // Google Calendar event id — это и есть slot id для ClientCard.slot_options
  summary: string; // полное название события, как есть в календаре
  start: string; // ISO datetime
  end: string; // ISO datetime
  tag: SlotTag; // какой из четырёх тегов у этого слота
}

// Превращает ISO datetime слота в человекочитаемую русскую строку для
// показа клиенту (например "вторник, 2 июля, 15:00"). Таймзона Israel,
// т.к. мастер и большинство клиентов в Хайфе/Израиле. Используется
// ТОЛЬКО для отображения — bookSlot() и матчинг "первый/второй" в
// Extractor-е продолжают работать с чистым event.id, не с этой строкой.
export function formatSlotForDisplay(slot: AvailableSlot): string {
  const date = new Date(slot.start);
  const dayName = date.toLocaleDateString('ru-RU', {
    weekday: 'long',
    timeZone: 'Asia/Jerusalem',
  });
  const dayMonth = date.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    timeZone: 'Asia/Jerusalem',
  });
  const time = date.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Jerusalem',
  });
  // Пометка формата ("(онлайн)"/"(в студии)"/"(walk-in)") — чтобы клиент
  // понимал, что выбирает, когда в одном списке разные виды слотов.
  return `${dayName}, ${dayMonth}, ${time}${tagDisplayLabel(slot.tag ?? null)}`;
}

// ----------------------------------------------------------
// АУТЕНТИФИКАЦИЯ — JWT service account, получаем access_token
// ----------------------------------------------------------

let cachedToken: { token: string; expiresAt: number } | null = null;

// Нормализует приватный ключ из env var — ПУЛЕНЕПРОБИВАЕМАЯ версия.
// Вместо попытки "почистить" разные варианты повреждения — извлекает
// чистый base64-контент из любого формата (с \n, без \n, с кавычками,
// с пробелами, с Windows-переводами строк) и пересобирает валидный
// PEM с нуля. Работает при ЛЮБОМ способе хранения ключа в Vercel.
function normalizePrivateKey(raw: string): string {
  let key = raw.trim();

  // Убрать обёрточные кавычки, если есть.
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1);
  }

  // Убрать все варианты переводов строк и escape-последовательностей,
  // чтобы получить одну сплошную строку.
  key = key.replace(/\\r\\n/g, ' ').replace(/\\n/g, ' ').replace(/\r\n/g, ' ').replace(/\n/g, ' ');

  // Извлечь чистый base64-контент между BEGIN и END маркерами.
  const match = key.match(
    /-----BEGIN (?:RSA )?PRIVATE KEY-----\s*(.+?)\s*-----END (?:RSA )?PRIVATE KEY-----/
  );

  if (!match || !match[1]) {
    // Если не нашли маркеры — вернуть как есть, пусть ошибка будет
    // информативной (вместо молчаливого повреждения).
    console.error('normalizePrivateKey: could not find PEM markers in key');
    return raw;
  }

  // Убрать все пробелы из base64 — получаем чистый контент.
  const base64Content = match[1].replace(/\s+/g, '');

  // Пересобрать валидный PEM: разбить base64 на строки по 64 символа
  // (стандарт PEM) и обернуть маркерами.
  const lines: string[] = [];
  for (let i = 0; i < base64Content.length; i += 64) {
    lines.push(base64Content.substring(i, i + 64));
  }

  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`;
}

// Извлекает email и private key сервисного аккаунта из env vars.
// ПРИОРИТЕТ: GOOGLE_SERVICE_ACCOUNT_JSON (весь JSON-файл целиком —
// самый надёжный путь, т.к. JSON.parse корректно обрабатывает \n
// внутри строки и ничего не теряется при копировании в Vercel).
// FALLBACK: отдельные GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY
// (может ломаться из-за искажения переносов строк Vercel-ом).
function getServiceAccountCredentials(): { email: string; privateKey: string } {
  const jsonRaw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  if (jsonRaw) {
    try {
      const parsed = JSON.parse(jsonRaw);
      const email = parsed.client_email;
      const privateKey = parsed.private_key;
      if (!email || !privateKey) {
        throw new Error('JSON parsed but client_email or private_key missing');
      }
      console.log('Service account loaded from GOOGLE_SERVICE_ACCOUNT_JSON:', {
        email,
        keyLength: privateKey.length,
        keyStart: privateKey.substring(0, 27),
      });
      return { email, privateKey };
    } catch (err) {
      console.error('Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON:', err);
      // Не падаем — попробуем fallback ниже.
    }
  }

  // Fallback: отдельные env vars.
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY;

  if (!email || !rawKey) {
    throw new Error(
      'Google credentials not found. Set GOOGLE_SERVICE_ACCOUNT_JSON (recommended) ' +
      'or GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY.'
    );
  }

  const privateKey = normalizePrivateKey(rawKey);

  console.log('GOOGLE_PRIVATE_KEY diagnostics (fallback):', {
    rawLength: rawKey.length,
    normalizedLength: privateKey.length,
    startsWithHeader: privateKey.startsWith('-----BEGIN PRIVATE KEY-----'),
    endsWithFooter: privateKey.trim().endsWith('-----END PRIVATE KEY-----'),
    lineCount: privateKey.split('\n').length,
  });

  return { email, privateKey };
}

async function getAccessToken(): Promise<string> {
  // Кэшируем токен на время жизни serverless-инстанса — Google токены
  // живут 1 час, нет смысла запрашивать новый на каждый вызов.
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }

  const { email, privateKey } = getServiceAccountCredentials();

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

// Политика мастера: длинная запись из Дневника "съедает" весь день — после
// нескольких часов тату-сессии или полной 2-часовой консультации мастеру
// нужен отдых, поэтому в этот день бот вообще не предлагает клиентам новые
// открытые слоты, даже если по времени формально нет пересечения.
const DAY_BLOCK_THRESHOLD_HOURS: Record<SlotType, number> = {
  tattoo: 4,
  consultation: 2,
};

export function jerusalemDayKey(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

// Дни, в которые уже стоит достаточно длинная запись из Дневника (маркер
// "ЗАНЯТО" — см. buildDiaryEventSummary), чтобы блокировать весь день
// целиком для НОВЫХ предложений клиентам.
export function computeDayBlockedSet(items: any[]): Set<string> {
  const blocked = new Set<string>();
  for (const event of items) {
    const summary: string = event.summary ?? '';
    if (!summary.includes('ЗАНЯТО')) continue; // блокирует день только своя запись из Дневника
    const eventTag = tagOf(summary);
    const eventType: SlotType | null =
      eventTag === '[ТАТУ]' ? 'tattoo' : eventTag === '[КОНС]' ? 'consultation' : null;
    if (!eventType) continue;
    const startIso: string | undefined = event.start?.dateTime;
    const endIso: string | undefined = event.end?.dateTime;
    if (!startIso || !endIso) continue;
    const hours = (new Date(endIso).getTime() - new Date(startIso).getTime()) / 3_600_000;
    if (hours >= DAY_BLOCK_THRESHOLD_HOURS[eventType]) {
      blocked.add(jerusalemDayKey(startIso));
    }
  }
  return blocked;
}

export async function getAvailableSlots(
  type: SlotType,
  maxResults = 3,
  opts?: { smallTattoo?: boolean }
): Promise<AvailableSlot[]> {
  const token = await getAccessToken();
  const wantedTags = tagsForRequest(type, opts);

  // НЕ используем q= — полнотекстовый поиск Google Calendar API
  // ненадёжно работает с квадратными скобками [ТАТУ]/[КОНС] (это
  // спецсимволы для их поискового движка). Берём ВСЕ будущие события
  // и фильтруем по точному совпадению тега кодом — надёжнее.
  const params = new URLSearchParams({
    timeMin: new Date().toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '100', // с запасом, точная фильтрация — ниже кодом
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

  // Диагностика: логируем что реально вернул календарь, чтобы видеть
  // в Vercel Logs точные названия событий при отладке несовпадений.
  console.log(
    'Calendar events.list raw summaries:',
    items.map((e) => e.summary)
  );

  const blockedDays = computeDayBlockedSet(items);

  const freeSlots: AvailableSlot[] = items
    .filter((event) => {
      const summary: string = event.summary ?? '';
      const eventTag = tagOf(summary);
      const isBusy = BUSY_MARKERS.some((marker) => summary.includes(marker));
      if (eventTag === null || !wantedTags.includes(eventTag) || isBusy) return false;
      const startIso: string | undefined = event.start?.dateTime;
      if (startIso && blockedDays.has(jerusalemDayKey(startIso))) return false;
      return true;
    })
    .map((event) => ({
      id: event.id,
      summary: event.summary,
      start: event.start?.dateTime ?? event.start?.date,
      end: event.end?.dateTime ?? event.end?.date,
      tag: tagOf(event.summary ?? '') as SlotTag,
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
  clientLabel: string, // имя клиента или username
  clientPhone?: string | null // телефон, если уже известен — чтобы Аня могла опознать/связаться по одной записи в календаре
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

  // Раньше тату-бронь помечалась просто "ОЖИДАЕТ ПРЕДОПЛАТЫ" без имени —
  // Аня не могла понять из календаря (или из /расписание, которое читает
  // те же summary), чья это запись. Теперь имя (и телефон, если уже
  // известен) дописываются для ВСЕХ типов брони — карточка в календаре
  // сама по себе достаточна, чтобы опознать и связаться с клиентом, не
  // открывая Airtable/Telegram отдельно.
  // Маркер выбирается по ТЕГУ самого события: [ONLINE] → "КОНС ОНЛАЙН",
  // очная [КОНС] → "КОНС ЗАПИСЬ", [ТАТУ]/[WALKIN] → "ОЖИДАЕТ ПРЕДОПЛАТЫ".
  const contact = clientPhone ? `${clientLabel}, ${clientPhone}` : clientLabel;
  const marker = `${busyMarkerForTag(tagOf(currentSummary), type)} — ${contact}`;
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

// ----------------------------------------------------------
// РАСПИСАНИЕ — ВСЕ события в окне (для admin-режима).
// В отличие от getAvailableSlots (только свободные [ТАТУ]/[КОНС]),
// здесь отдаём всё, что стоит в календаре у Ани — занятые слоты,
// свободные слоты и любые её личные события — чтобы она видела
// реальную картину дня/недели.
// ----------------------------------------------------------

export interface ScheduleEvent {
  id: string;
  summary: string;
  start: string; // ISO datetime или YYYY-MM-DD для событий на весь день
  end: string;
  isBusy: boolean; // слот уже занят (маркер занятости в названии)
  type: SlotType | null; // 'tattoo' | 'consultation' | null (личное событие)
  allDay: boolean;
}

export async function getSchedule(days = 7): Promise<ScheduleEvent[]> {
  const token = await getAccessToken();

  const params = new URLSearchParams({
    timeMin: new Date().toISOString(),
    timeMax: new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '100',
  });

  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
    CALENDAR_ID
  )}/events?${params.toString()}`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Calendar schedule list failed: ${response.status} ${errText}`);
  }

  const data = await response.json();
  const items: any[] = data.items ?? [];

  return items.map((event) => {
    const summary: string = event.summary ?? '(без названия)';
    const isBusy = BUSY_MARKERS.some((marker) => summary.includes(marker));
    // Все 4 тега: [ТАТУ]/[WALKIN] — тату-слоты, [КОНС]/[ONLINE] — консы.
    // Сам тег виден в raw summary, отдельно его не дублируем.
    const eventTag = tagOf(summary);
    const type: SlotType | null =
      eventTag === '[ТАТУ]' || eventTag === '[WALKIN]'
        ? 'tattoo'
        : eventTag === '[КОНС]' || eventTag === '[ONLINE]'
        ? 'consultation'
        : null;
    const allDay = !event.start?.dateTime;
    return {
      id: event.id,
      summary,
      start: event.start?.dateTime ?? event.start?.date,
      end: event.end?.dateTime ?? event.end?.date,
      isBusy,
      type,
      allDay,
    };
  });
}

// Человекочитаемое расписание, сгруппированное по дням, для отправки
// Ане в Telegram. 🟢 — свободный слot, 🔴 — занятый, • — личное событие.
export function formatSchedule(events: ScheduleEvent[]): string {
  if (events.length === 0) {
    return 'на ближайшие дни в календаре пусто.';
  }

  const byDay = new Map<string, string[]>();
  const dayOrder: string[] = [];

  for (const e of events) {
    const d = new Date(e.start);
    const dayKey = d.toLocaleDateString('ru-RU', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      timeZone: 'Asia/Jerusalem',
    });
    if (!byDay.has(dayKey)) {
      byDay.set(dayKey, []);
      dayOrder.push(dayKey);
    }
    const time = e.allDay
      ? 'весь день'
      : d.toLocaleTimeString('ru-RU', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'Asia/Jerusalem',
        });
    const mark = e.isBusy ? '🔴' : e.type ? '🟢' : '•';
    byDay.get(dayKey)!.push(`  ${mark} ${time} — ${e.summary}`);
  }

  const blocks = dayOrder.map((day) => `📅 ${day}\n${byDay.get(day)!.join('\n')}`);
  return blocks.join('\n\n');
}

// ----------------------------------------------------------
// СИНХРОНИЗАЦИЯ С ДНЕВНИКОМ МАСТЕРА (мост Дневник → календарь → бот).
// Дневник — отдельное приложение мастера; когда она ставит там запись,
// та кладётся В ТОТ ЖЕ календарь, что читает бот (getSchedule), поэтому
// на "что на неделе" запись из Дневника видна автоматически.
//
// Здесь — создание/обновление/удаление события С НУЛЯ (events.insert /
// patch / delete), в отличие от bookSlot(), который только переименовывает
// уже созданный мастером слот.
//
// ВАЖНО: события из Дневника помечаются маркером "ЗАНЯТО" — тогда
// getAvailableSlots (которая исключает BUSY_MARKERS) НЕ предложит их
// клиенту как свободный слот. Это защита от двойной записи: реальная
// встреча из Дневника не должна попасть в пул свободных для клиентов.
// ----------------------------------------------------------

// Детерминированный id события Google по стабильному id записи Дневника.
// Требования Google: [a-v0-9], длина 5..1024. hex-хэш (0-9a-f) — валидное
// подмножество, префикс 'd' (в a-v) неймспейсит diary-события. Один и тот
// же diaryId всегда даёт тот же eventId → повторная синхронизация
// ОБНОВЛЯЕТ то же событие, а не плодит дубли.
export function diaryEventId(diaryId: string): string {
  return 'd' + createHash('sha1').update(diaryId).digest('hex');
}

// Короткая строка названия события Дневника. Начинается с тега
// [ТАТУ]/[КОНС] (чтобы getSchedule определил тип) и содержит "ЗАНЯТО"
// (чтобы getAvailableSlots исключила из свободных).
export function buildDiaryEventSummary(
  type: SlotType,
  clientName: string | null,
  descriptor: string | null
): string {
  const head = `${SLOT_TAG[type]} ЗАНЯТО`;
  const tail = [clientName, descriptor].filter(Boolean).join(' · ');
  return tail ? `${head} — ${tail}` : head;
}

// Более полное описание (поле notes события) — видно, когда мастер
// открывает запись в календаре.
export function buildDiaryEventDescription(
  clientName: string | null,
  descriptor: string | null
): string {
  const lines = ['📓 из Дневника мастера'];
  if (clientName) lines.push(`клиент: ${clientName}`);
  if (descriptor) lines.push(descriptor);
  return lines.join('\n');
}

// Конец встречи как локальное wall-clock время (наивная строка без
// смещения — Google интерпретирует её по timeZone). Считаем через UTC
// как чистую арифметику часов/минут; редкий переход на летнее время
// внутри одной встречи не обрабатываем — для длительности брони это не
// критично.
export function computeEndNaive(date: string, time: string, durationMin: number): string {
  const start = new Date(`${date}T${time}:00Z`);
  const end = new Date(start.getTime() + durationMin * 60_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${end.getUTCFullYear()}-${p(end.getUTCMonth() + 1)}-${p(end.getUTCDate())}` +
    `T${p(end.getUTCHours())}:${p(end.getUTCMinutes())}:00`
  );
}

export interface DiaryEventInput {
  startNaive: string; // "YYYY-MM-DDTHH:MM:SS" — локальное время (Asia/Jerusalem)
  endNaive: string;
  summary: string;
  description: string;
}

export interface DiarySyncResult {
  ok: boolean;
  created?: boolean; // true = создано новое событие, false = обновлено существующее
  error?: string;
  // Абсолютное время события, как его разрешил Google (RFC3339 со смещением) —
  // нужно для проверки пересечений без самодельной таймзонной арифметики.
  resolvedStart?: string;
  resolvedEnd?: string;
}

// Создать ИЛИ обновить событие Дневника по детерминированному eventId.
// Сначала insert; если событие с таким id уже есть (409) — patch. Так
// повторная синхронизация одной записи не создаёт дубль, а обновляет.
export async function upsertDiaryEvent(
  eventId: string,
  input: DiaryEventInput
): Promise<DiarySyncResult> {
  const token = await getAccessToken();
  const eventBody = {
    summary: input.summary,
    description: input.description,
    start: { dateTime: input.startNaive, timeZone: 'Asia/Jerusalem' },
    end: { dateTime: input.endNaive, timeZone: 'Asia/Jerusalem' },
  };

  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
    CALENDAR_ID
  )}/events`;

  // Ответ Google на insert/patch содержит событие с уже разрешённым
  // абсолютным временем (start/end.dateTime с офсетом) — берём его для
  // последующей проверки пересечений.
  const resolvedTimes = async (res: Response) => {
    const ev = await res.json().catch(() => null);
    return {
      resolvedStart: ev?.start?.dateTime as string | undefined,
      resolvedEnd: ev?.end?.dateTime as string | undefined,
    };
  };

  const insertResponse = await fetch(base, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: eventId, ...eventBody }),
  });

  if (insertResponse.ok) {
    return { ok: true, created: true, ...(await resolvedTimes(insertResponse)) };
  }

  if (insertResponse.status === 409) {
    // Событие уже существует — обновляем его.
    const patchResponse = await fetch(`${base}/${encodeURIComponent(eventId)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(eventBody),
    });
    if (patchResponse.ok) {
      return { ok: true, created: false, ...(await resolvedTimes(patchResponse)) };
    }
    return {
      ok: false,
      error: `diary events.patch failed: ${patchResponse.status} ${await patchResponse.text()}`,
    };
  }

  return {
    ok: false,
    error: `diary events.insert failed: ${insertResponse.status} ${await insertResponse.text()}`,
  };
}

// Удалить событие Дневника. Отсутствие события (404/410) считаем успехом —
// удаление идемпотентно.
export async function deleteDiaryEvent(eventId: string): Promise<DiarySyncResult> {
  const token = await getAccessToken();
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
    CALENDAR_ID
  )}/events/${encodeURIComponent(eventId)}`;

  const res = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.ok || res.status === 404 || res.status === 410) {
    return { ok: true };
  }
  return { ok: false, error: `diary events.delete failed: ${res.status} ${await res.text()}` };
}

// ----------------------------------------------------------
// ПРОВЕРКА ПЕРЕСЕЧЕНИЙ — «а не стоит ли на это время что-то ещё?»
// Дневник не читает календарь перед сохранением, поэтому мастер могла
// поставить сессию поверх брони бота, не заметив. После синхронизации
// «дверца» ищет пересекающиеся события и возвращает их Дневнику —
// тот показывает предупреждение. Запись НЕ блокируется: решение за
// мастером (возможно, параллельная запись поставлена сознательно).
// ----------------------------------------------------------

export interface ConflictInfo {
  summary: string;
  start: string;
  end: string;
}

// Семантика timeMin/timeMax у Google (нижняя граница по КОНЦУ события,
// верхняя — по НАЧАЛУ) — это ровно определение пересечения интервалов,
// поэтому фильтр «наши границы как timeMin/timeMax» отдаёт в точности
// пересекающиеся события; остаётся исключить само синхронизируемое.
export async function findDiaryConflicts(
  selfEventId: string,
  startAbs: string,
  endAbs: string
): Promise<ConflictInfo[]> {
  const token = await getAccessToken();
  const params = new URLSearchParams({
    timeMin: startAbs,
    timeMax: endAbs,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '10',
  });
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
    CALENDAR_ID
  )}/events?${params.toString()}`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`conflict check failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const items: any[] = data.items ?? [];
  return items
    .filter((e) => e.id !== selfEventId && e.status !== 'cancelled')
    .map((e) => ({
      summary: e.summary ?? '(без названия)',
      start: e.start?.dateTime ?? e.start?.date,
      end: e.end?.dateTime ?? e.end?.date,
    }));
}

// ----------------------------------------------------------
// СОЗДАНИЕ ОТКРЫТОГО СЛОТА (ШАГ 3 — admin-команда /добавить).
// В отличие от upsertDiaryEvent (которая создаёт УЖЕ ЗАНЯТУЮ запись с
// маркером "ЗАНЯТО"), эта функция создаёт ПУСТОЙ слот — просто [ТЕГ] без
// маркера занятости. Такой слот сразу подхватывается getAvailableSlots
// и может быть предложен клиенту, как если бы мастер создала его вручную.
// ----------------------------------------------------------

export interface CreateSlotResult {
  ok: boolean;
  eventId?: string;
  resolvedStart?: string;
  resolvedEnd?: string;
  error?: string;
}

export async function createOpenSlot(
  tag: SlotTag,
  startNaive: string,
  endNaive: string
): Promise<CreateSlotResult> {
  const token = await getAccessToken();
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
    CALENDAR_ID
  )}/events`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary: tag,
      start: { dateTime: startNaive, timeZone: 'Asia/Jerusalem' },
      end: { dateTime: endNaive, timeZone: 'Asia/Jerusalem' },
    }),
  });

  if (!res.ok) {
    return { ok: false, error: `createOpenSlot events.insert failed: ${res.status} ${await res.text()}` };
  }

  const ev = await res.json();
  return {
    ok: true,
    eventId: ev.id,
    resolvedStart: ev.start?.dateTime,
    resolvedEnd: ev.end?.dateTime,
  };
}
