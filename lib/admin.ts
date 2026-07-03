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
  type ClientRecord,
} from './airtable';
import { getSchedule, formatSchedule } from './calendar';

export interface AdminMessage {
  text: string | null;
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

  // Всё остальное — свободный диалог.
  const userContent = JSON.stringify(
    { mode: 'dialog', today: new Date().toISOString().slice(0, 10), message: raw },
    null,
    2
  );
  return { reply: await callAdminLLM(userContent) };
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
// LLM (портрет и свободный диалог)
// ----------------------------------------------------------

let cachedPrompt: string | null = null;

function getAdminPrompt(): string {
  if (cachedPrompt) return cachedPrompt;
  const promptPath = path.join(process.cwd(), 'lib', 'adminPrompt.txt');
  cachedPrompt = fs.readFileSync(promptPath, 'utf-8');
  return cachedPrompt;
}

async function callAdminLLM(userContent: string): Promise<string> {
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
