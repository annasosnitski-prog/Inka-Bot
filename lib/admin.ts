// ============================================================
// INKA-BOT — Admin mode (ШАГ 7)
// Отдельный обработчик для сообщений МАСТЕРА (Ани). Клиентский
// Extractor / state machine / Responder здесь НЕ участвуют — Аня не
// клиент, прогонять её через воронку бессмысленно и вредно (засоряет
// её карточку). telegram.ts перехватывает мастера ДО клиентского
// пайплайна и зовёт runAdmin().
//
// Возможности v1:
//   /счёт  [имя|пересылка]  — сводка по клиенту: идея, цена, предоплата
//   /портрет [имя|пересылка] — психологический портрет + подготовка (LLM)
//   /расписание [сегодня|неделя|месяц] — календарь Ани из Google
//   всё остальное — свободный диалог (LLM-ассистент)
//
// Клиент определяется двумя способами:
//   1) пересылка сообщения клиента боту → точный telegram_id из forward;
//   2) имя / @username текстом → поиск в Airtable (может быть неоднозначным).
// ============================================================

import fs from 'fs';
import path from 'path';
import {
  findClientByTelegramId,
  findClientsByName,
  upsertClient,
  type ClientRecord,
} from './airtable';
import {
  getSchedule,
  formatSchedule,
  createOpenSlot,
  findDiaryConflicts,
  createMasterCloseBlock,
  findEventsOnDate,
  deleteDiaryEvent,
  TATTOO_DAY_BLOCK_HOURS,
} from './calendar';
import { parseAddSlotCommand, parseCloseCommand, parseDeleteCommand } from './addSlotParser';

export interface AdminMessage {
  text: string | null;
  masterTelegramId: number; // telegram_id самой Ани — для памяти диалога (её же запись в Airtable)
  forwardFromId: number | null; // id исходного отправителя пересланного сообщения (если доступен)
  forwardName: string | null; // имя из пересылки (fallback, если id скрыт приватностью)
}

export interface AdminResult {
  reply: string;
}

// ----------------------------------------------------------
// РОУТЕР
// ----------------------------------------------------------

const INVOICE_CMDS = ['/счёт', '/счет', '/invoice', 'счёт', 'счет'];
const PORTRAIT_CMDS = ['/портрет', '/portrait', 'портрет'];
const SCHEDULE_CMDS = ['/расписание', '/schedule', 'расписание'];
const ADD_SLOT_CMDS = ['/добавить', '/добавь', '/add', 'добавить', 'добавь'];
const CLOSE_SLOT_CMDS = ['/закрой', '/закрыть', 'закрой', 'закрыть', '/close', 'close'];
const DELETE_SLOT_CMDS = ['/удали', '/удалить', 'удали', 'удалить', '/delete', 'delete'];

// Естественный запрос расписания без команды: "что по записям", "какие
// записи", "покажи расписание/календарь". Держим узко (запис/расписан/
// календар), чтобы не перехватывать вопросы про конкретного клиента.
export function isScheduleRequest(text: string): boolean {
  return /запис|расписан|календар/i.test(text);
}

export async function runAdmin(msg: AdminMessage): Promise<AdminResult> {
  const raw = (msg.text ?? '').trim();

  // Пересылка сообщения клиента обрабатывается ПЕРВОЙ: её текст — это
  // слова клиента, а не команда Ани, поэтому парсить его как команду
  // нельзя. Точный telegram_id уже есть из forward — показываем сводку
  // (/счёт) по умолчанию + подсказку, как получить портрет.
  if (msg.forwardFromId) {
    const invoice = await handleInvoice(msg, '');
    const who = msg.forwardName ? ` ${msg.forwardName}` : '';
    return { reply: `${invoice}\n\nнужен портрет — напиши: /портрет${who}` };
  }

  const firstWord = (raw.split(/\s+/)[0] ?? '').toLowerCase();
  const rest = raw.slice(firstWord.length).trim();

  if (INVOICE_CMDS.includes(firstWord)) {
    return { reply: await handleInvoice(msg, rest) };
  }
  if (PORTRAIT_CMDS.includes(firstWord)) {
    return { reply: await handlePortrait(msg, rest) };
  }
  if (SCHEDULE_CMDS.includes(firstWord)) {
    return { reply: await handleSchedule(rest) };
  }
  if (ADD_SLOT_CMDS.includes(firstWord)) {
    return { reply: await handleAddSlot(rest) };
  }
  if (CLOSE_SLOT_CMDS.includes(firstWord)) {
    return { reply: await handleCloseSlot(rest) };
  }
  if (DELETE_SLOT_CMDS.includes(firstWord)) {
    return { reply: await handleDeleteSlot(rest) };
  }

  // Естественные фразы про расписание/записи — не команда, но по смыслу
  // запрос календаря ("что по записям", "какие записи сегодня", "покажи
  // календарь"). Тянем реальное расписание, а не отправляем в диалог,
  // который календарь не видит.
  if (isScheduleRequest(raw)) {
    return { reply: await handleSchedule(raw) };
  }

  // Всё остальное — свободный диалог. С ПАМЯТЬЮ: подтягиваем последние
  // реплики этого же диалога с Аней (её собственная запись в Airtable,
  // та же, что заводится при переключении /client-/admin), иначе каждое
  // сообщение уходит в LLM изолированно и она "не помнит", о чём шла речь
  // минуту назад.
  const history = await loadDialogHistory(msg.masterTelegramId);
  const userContent = JSON.stringify(
    { mode: 'dialog', today: new Date().toISOString().slice(0, 10), message: raw },
    null,
    2
  );
  const reply = await callAdminLLM(userContent, history);
  await saveDialogHistory(msg.masterTelegramId, history, raw, reply);
  return { reply };
}

// ----------------------------------------------------------
// РАЗРЕШЕНИЕ ЦЕЛИ (какой клиент)
// ----------------------------------------------------------

type TargetResult =
  | { kind: 'found'; record: ClientRecord }
  | { kind: 'none' }
  | { kind: 'ambiguous'; records: ClientRecord[] }
  | { kind: 'no_query' };

async function resolveTarget(msg: AdminMessage, nameArg: string): Promise<TargetResult> {
  // Пересылка имеет приоритет — точный telegram_id надёжнее имени.
  if (msg.forwardFromId) {
    const rec = await findClientByTelegramId(msg.forwardFromId);
    return rec ? { kind: 'found', record: rec } : { kind: 'none' };
  }

  const q = nameArg.trim();
  if (!q) return { kind: 'no_query' };

  const recs = await findClientsByName(q);
  if (recs.length === 0) return { kind: 'none' };
  if (recs.length === 1) return { kind: 'found', record: recs[0] };
  return { kind: 'ambiguous', records: recs };
}

function ambiguousList(records: ClientRecord[]): string {
  const lines = records.map((r) => {
    const f = r.fields;
    const name = f.name ?? '—';
    const uname = f.username ? ` (@${f.username})` : '';
    return `• ${name}${uname}`;
  });
  return 'нашла несколько:\n' + lines.join('\n') + '\nуточни имя точнее или перешли сообщение клиента.';
}

// ----------------------------------------------------------
// /счёт — сводка по клиенту (детерминированное форматирование)
// ----------------------------------------------------------

async function handleInvoice(msg: AdminMessage, nameArg: string): Promise<string> {
  const t = await resolveTarget(msg, nameArg);
  if (t.kind === 'no_query') {
    return 'кого показать? перешли сообщение клиента боту или напиши: /счёт Имя';
  }
  if (t.kind === 'none') {
    return 'не нашла такого клиента в базе. проверь имя или перешли его сообщение боту.';
  }
  if (t.kind === 'ambiguous') {
    return ambiguousList(t.records);
  }
  return formatInvoice(t.record.fields);
}

function depositLabel(status: any): string {
  switch (status) {
    case 'waiting_prepayment':
      return 'ожидает предоплату 200₪';
    case 'waiting_confirmation':
      return 'прислал скрин — нужно подтвердить';
    case 'paid':
      return 'оплачено ✅';
    default:
      return '—';
  }
}

function leadStatusLabel(status: any): string {
  switch (status) {
    case 'new':
      return 'новый';
    case 'diagnosing':
      return 'выясняем детали';
    case 'estimated':
      return 'названа цена';
    case 'wants_booking':
      return 'хочет записаться';
    case 'slots_shown':
      return 'показаны слоты';
    case 'consultation_booked':
      return 'консультация забронирована';
    case 'tattoo_booked_waiting_payment':
      return 'тату забронировано, ждёт предоплату';
    case 'waiting_slots':
      return 'в листе ожидания слотов';
    case 'waiting_slots_pinged':
      return 'в листе ожидания (передано мастеру)';
    case 'blocked':
      return 'заблокирован';
    default:
      return status ? String(status) : '—';
  }
}

export function formatInvoice(f: Record<string, any>): string {
  const who = f.name
    ? `${f.name}${f.username ? ` (@${f.username})` : ''}`
    : f.username
    ? `@${f.username}`
    : 'клиент';

  const lines = [
    `🧾 ${who}`,
    f.phone ? `телефон: ${f.phone}` : null,
    f.idea ? `идея: ${f.idea}` : null,
    f.size || f.placement ? `размер/место: ${f.size ?? '—'} / ${f.placement ?? '—'}` : null,
    f.category ? `категория: ${f.category}` : null,
    `цена: ${f.price_quoted ?? '—'}`,
    `предоплата: ${depositLabel(f.deposit_status)}`,
    `статус: ${leadStatusLabel(f.lead_status)}`,
  ].filter((l): l is string => Boolean(l));

  return lines.join('\n');
}

// ----------------------------------------------------------
// /портрет — психологический портрет + подготовка к встрече (LLM)
// ----------------------------------------------------------

async function handlePortrait(msg: AdminMessage, nameArg: string): Promise<string> {
  const t = await resolveTarget(msg, nameArg);
  if (t.kind === 'no_query') {
    return 'про кого портрет? перешли сообщение клиента боту или напиши: /портрет Имя';
  }
  if (t.kind === 'none') {
    return 'не нашла такого клиента в базе. проверь имя или перешли его сообщение боту.';
  }
  if (t.kind === 'ambiguous') {
    return ambiguousList(t.records);
  }

  const f = t.record.fields;
  const client = {
    name: f.name ?? null,
    username: f.username ?? null,
    idea: f.idea ?? null,
    size: f.size ?? null,
    placement: f.placement ?? null,
    category: f.category ?? null,
    first_tattoo: f.first_tattoo ?? null,
    existing_tattoo: f.existing_tattoo ?? null,
    skin_notes: f.skin_notes ?? null,
    client_type: f.client_type ?? null,
    lead_status: f.lead_status ?? null,
    wants_to_book: f.wants_to_book ?? null,
    last_message: f.last_message ?? null,
  };

  const userContent = JSON.stringify({ mode: 'portrait', client }, null, 2);
  return await callAdminLLM(userContent);
}

// ----------------------------------------------------------
// /расписание — календарь Ани из Google
// ----------------------------------------------------------

async function handleSchedule(arg: string): Promise<string> {
  const a = arg.toLowerCase();
  let days = 7; // по умолчанию неделя
  if (a.includes('сегодня')) days = 1;
  else if (a.includes('завтра')) days = 2;
  else if (a.includes('месяц')) days = 30;
  else if (a.includes('недел')) days = 7;

  const events = await getSchedule(days);
  const header = days === 1 ? 'на сегодня:' : days <= 2 ? 'на ближайшие дни:' : days >= 30 ? 'на месяц:' : 'на неделю:';
  return `${header}\n\n${formatSchedule(events)}`;
}

// ----------------------------------------------------------
// /добавить — создать открытый слот в календаре (ШАГ 3).
// Разбор ДЕТЕРМИНИРОВАННЫЙ (lib/addSlotParser.ts, без LLM) — ошибка
// здесь означает неправильный слот, который увидят клиенты, поэтому
// не гадаем: формат не распознан → просим переформулировать по образцу.
// ----------------------------------------------------------

function humanDate(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  return d.toLocaleDateString('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'Asia/Jerusalem',
  });
}

async function handleAddSlot(arg: string): Promise<string> {
  if (!arg.trim()) {
    return (
      'что и когда поставить (только окно/видео — открытый слот для нового клиента)? например:\n' +
      '/добавить окно пятница 12:00-14:00\n' +
      '/добавить видео завтра 10:00-10:30'
    );
  }

  const parsed = parseAddSlotCommand(arg, new Date());
  if (!parsed.ok) {
    return `${parsed.error}\nпример: /добавить окно пятница 12:00-14:00`;
  }

  const startNaive = `${parsed.date}T${parsed.startTime}:00`;
  const endNaive = `${parsed.date}T${parsed.endTime}:00`;

  const result = await createOpenSlot(parsed.tag, startNaive, endNaive);
  if (!result.ok) {
    console.error('handleAddSlot: createOpenSlot failed:', result.error);
    return 'не получилось создать слот — глянь логи.';
  }

  const when = `${humanDate(parsed.date)}, ${parsed.startTime}–${parsed.endTime}`;
  let reply = `готово: ${parsed.tag} ${when}`;

  // Пересечение не блокирует создание — только предупреждаем, как в
  // синхронизации Дневника (mастер сама решает, накладка это или нет).
  if (result.resolvedStart && result.resolvedEnd && result.eventId) {
    try {
      const conflicts = await findDiaryConflicts(result.eventId, result.resolvedStart, result.resolvedEnd);
      if (conflicts.length > 0) {
        const lines = conflicts.slice(0, 3).map((c) => c.summary);
        reply += `\n\n⚠️ на это время уже есть: ${lines.join('; ')}`;
      }
    } catch (confErr) {
      console.error('handleAddSlot: conflict check failed (non-fatal):', confErr);
    }
  }

  return reply;
}

// ----------------------------------------------------------
// /закрой — быстро заблокировать день/окно, не открывая Дневник прямо
// сейчас. Приём — весь день (только консультации). Тату — время
// обязательно; ≥4ч блокирует весь день целиком (как реальная сессия из
// Дневника), короче — только это окно (только тату).
// ----------------------------------------------------------

function familyLabel(family: 'tattoo' | 'consultation'): string {
  return family === 'tattoo' ? 'тату' : 'консультации';
}

async function handleCloseSlot(arg: string): Promise<string> {
  if (!arg.trim()) {
    return (
      'что и когда закрыть? например:\n' +
      '/закрой приём 20.07 10:00-12:00 [имя]\n' +
      '/закрой тату 20.07 09:00-14:00 [имя]'
    );
  }

  const parsed = parseCloseCommand(arg, new Date());
  if (!parsed.ok) {
    return `${parsed.error}\nпример: /закрой приём 20.07 10:00-12:00 [имя] или /закрой тату 20.07 09:00-14:00 [имя]`;
  }

  const timeRangeNaive = {
    startNaive: `${parsed.date}T${parsed.timeRange.startTime}:00`,
    endNaive: `${parsed.date}T${parsed.timeRange.endTime}:00`,
  };

  const result = await createMasterCloseBlock(parsed.family, timeRangeNaive, parsed.name);
  if (!result.ok) {
    console.error('handleCloseSlot: createMasterCloseBlock failed:', result.error);
    return 'не получилось закрыть — глянь логи.';
  }

  const when = `${humanDate(parsed.date)}, ${parsed.timeRange.startTime}–${parsed.timeRange.endTime}`;
  const nameSuffix = parsed.name ? ` — ${parsed.name}` : '';

  let scope = ' (только это окно, для консультаций)';
  if (parsed.family === 'tattoo') {
    const [h1, m1] = parsed.timeRange.startTime.split(':').map(Number);
    const [h2, m2] = parsed.timeRange.endTime.split(':').map(Number);
    const hours = (h2 * 60 + m2 - (h1 * 60 + m1)) / 60;
    scope =
      hours >= TATTOO_DAY_BLOCK_HOURS
        ? ' (весь день закрыт для любых записей)'
        : ' (только это окно, для тату)';
  }

  return `закрыла: ${familyLabel(parsed.family)}, ${when}${nameSuffix}${scope}`;
}

// ----------------------------------------------------------
// /удалить — снять существующую запись/бронь из календаря целиком.
// Если находится больше одной — просим уточнить имя/время, ничего не
// удаляем вслепую (это реальное действие с чужим/своим временем).
// ----------------------------------------------------------

async function handleDeleteSlot(arg: string): Promise<string> {
  if (!arg.trim()) {
    return 'что и когда удалить? например:\n/удалить приём 20.07 [имя]\n/удалить тату 20.07 [имя]';
  }

  const parsed = parseDeleteCommand(arg, new Date());
  if (!parsed.ok) {
    return `${parsed.error}\nпример: /удалить приём 20.07 [имя]`;
  }

  let candidates;
  try {
    candidates = await findEventsOnDate(parsed.date, parsed.family);
  } catch (err) {
    console.error('handleDeleteSlot: findEventsOnDate failed:', err);
    return 'не получилось найти записи — глянь логи.';
  }

  if (parsed.name) {
    const nameLower = parsed.name.toLowerCase();
    const filtered = candidates.filter((c) => c.summary.toLowerCase().includes(nameLower));
    if (filtered.length > 0) candidates = filtered;
  }

  if (candidates.length === 0) {
    return `ничего не нашла на ${humanDate(parsed.date)} (${familyLabel(parsed.family)}).`;
  }
  if (candidates.length > 1) {
    const lines = candidates.map((c) => `• ${c.summary}`);
    return `нашла несколько на ${humanDate(parsed.date)}:\n${lines.join('\n')}\nуточни имя или добавь ещё деталей — не хочу удалить не то.`;
  }

  const target = candidates[0];
  const result = await deleteDiaryEvent(target.id);
  if (!result.ok) {
    console.error('handleDeleteSlot: deleteDiaryEvent failed:', result.error);
    return 'не получилось удалить — глянь логи.';
  }
  return `удалила: ${target.summary} (${humanDate(parsed.date)})`;
}

// ----------------------------------------------------------
// LLM (портрет и свободный диалог)
// ----------------------------------------------------------

let cachedPrompt: string | null = null;

function getAdminPrompt(): string {
  if (cachedPrompt) return cachedPrompt;
  const promptPath = path.join(process.cwd(), 'lib', 'adminPrompt.txt');
  cachedPrompt = fs.readFileSync(promptPath, 'utf-8');
  return cachedPrompt;
}

async function callAdminLLM(userContent: string, history: DialogTurn[] = []): Promise<string> {
  const systemPrompt = getAdminPrompt();

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-5.4',
      temperature: 0.6,
      messages: [
        { role: 'system', content: systemPrompt },
        ...history.map((h) => ({ role: h.role, content: h.content })),
        { role: 'user', content: userContent },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Admin OpenAI call failed: ${response.status} ${errText}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error('Admin: empty response from OpenAI');
  }
  return text.trim();
}

// ----------------------------------------------------------
// ПАМЯТЬ СВОБОДНОГО ДИАЛОГА С МАСТЕРОМ.
// Serverless-функция ничего не помнит между сообщениями сама — храним
// последние реплики в её же записи Airtable (та же, что заводится
// переключателем /client-/admin), поле admin_dialog_history (JSON-массив).
// Только для mode="dialog" — портрет клиента это разовый анализ чужих
// данных, мешать его с разговором Ани не нужно. Ограничено последними
// MAX_HISTORY репликами: и по деньгам не заметно (несколько KB текста
// на запрос), и Airtable Long text не резиновый.
// ----------------------------------------------------------

export interface DialogTurn {
  role: 'user' | 'assistant';
  content: string;
}

export const MAX_HISTORY_TURNS = 40; // реплик всего (не пар) — ~20 обменов, по просьбе Ани (было 12/~6)

export async function loadDialogHistory(masterTelegramId: number): Promise<DialogTurn[]> {
  try {
    const record = await findClientByTelegramId(masterTelegramId);
    const raw = record?.fields?.admin_dialog_history;
    if (!raw || typeof raw !== 'string') return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is DialogTurn =>
        t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string'
    );
  } catch (err) {
    console.error('loadDialogHistory failed (non-fatal, старт с чистого листа):', err);
    return [];
  }
}

export async function saveDialogHistory(
  masterTelegramId: number,
  prevHistory: DialogTurn[],
  userMessage: string,
  assistantReply: string
): Promise<void> {
  try {
    const updated = [
      ...prevHistory,
      { role: 'user' as const, content: userMessage },
      { role: 'assistant' as const, content: assistantReply },
    ].slice(-MAX_HISTORY_TURNS);
    await upsertClient(masterTelegramId, { admin_dialog_history: JSON.stringify(updated) });
  } catch (err) {
    // Сбой сохранения истории не должен ломать сам ответ — в следующий
    // раз диалог просто начнётся немного "с чистого листа".
    console.error('saveDialogHistory failed (non-fatal):', err);
  }
}
