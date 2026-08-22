// ============================================================
// INKA-BOT — Dialog history (Airtable)
// Хранит переписку клиент↔Инка в самой записи клиента в Airtable
// (поле dialog_history, JSON-массив реплик) — Аня поднимает историю
// командой /история в admin-режиме (см. lib/admin.ts). Не зависит от
// членства в каких-либо Telegram-группах: раньше лог зеркалился в
// отдельную супергруппу с топиками, но это была лишняя точка отказа —
// выйти/потерять доступ к группе значило потерять весь лог.
//
// НАСТРОЙКА (один раз, вручную у Ани):
//   Добавить в таблицу Airtable колонку dialog_history — тип Long text.
// ============================================================

import { updateClient, type ClientRecord } from './airtable';

export interface DialogEntry {
  from: 'client' | 'inka';
  text: string;
  ts: string; // ISO
}

export const MAX_CLIENT_HISTORY_TURNS = 100; // реплик всего (клиент+инка вместе), ~50 обменов

export function parseDialogHistory(record: ClientRecord | null): DialogEntry[] {
  const raw = record?.fields?.dialog_history;
  if (!raw || typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is DialogEntry =>
        e && (e.from === 'client' || e.from === 'inka') && typeof e.text === 'string'
    );
  } catch (err) {
    console.error('parseDialogHistory failed (non-fatal, показываем пустую историю):', err);
    return [];
  }
}

// Отличает «истории правда нет» от «поле dialog_history есть, но не
// разбирается» (например кто-то вписал в Long text не-JSON вручную —
// appendDialogTurn всегда пишет валидный JSON, значит проблема снаружи
// обычного потока). parseDialogHistory в обоих случаях тихо отдаёт [] —
// это ок для самого лога (появится валидный JSON со следующим обменом),
// но команде /история важно не соврать мастеру, что переписки не было.
export function hasUnparsableDialogHistory(record: ClientRecord | null): boolean {
  const raw = record?.fields?.dialog_history;
  if (!raw || typeof raw !== 'string') return false;
  try {
    const parsed = JSON.parse(raw);
    return !Array.isArray(parsed);
  } catch {
    return true;
  }
}

// Дописывает один обмен репликами (клиент + Инка) в историю и сохраняет
// в Airtable. Вызывается ПОСЛЕ отправки ответа клиенту — никогда не
// бросает исключение наружу, сбой логирования не должен ломать основной
// пайплайн.
export async function appendDialogTurn(
  record: ClientRecord | null,
  clientMessage: string | null,
  inkaReply: string | null
): Promise<void> {
  if (!record) return;
  if (!clientMessage && !inkaReply) return;

  try {
    const now = new Date().toISOString();
    const history = parseDialogHistory(record);
    if (clientMessage) history.push({ from: 'client', text: clientMessage, ts: now });
    if (inkaReply) history.push({ from: 'inka', text: inkaReply, ts: now });
    const trimmed = history.slice(-MAX_CLIENT_HISTORY_TURNS);
    await updateClient(record.id, { dialog_history: JSON.stringify(trimmed) });
  } catch (err) {
    console.error('appendDialogTurn failed (non-fatal):', err);
  }
}

// Форматирует историю для показа мастеру текстом (команда /история).
export function formatDialogHistory(entries: DialogEntry[]): string {
  return entries.map((e) => (e.from === 'client' ? `👤 ${e.text}` : `🤖 ${e.text}`)).join('\n\n');
}

// Сколько последних реплик (клиент+инка вместе) отдавать Extractor-у и
// Responder-у как контекст этого хода — НЕ весь MAX_CLIENT_HISTORY_TURNS
// (100), это раздуло бы токены на каждое сообщение. До этой правки оба
// вызова видели только client_card + голое последнее сообщение — без
// памяти "что я только что спросила", короткий ответ клиента ("нет",
// "да", "думаю") нечем было привязать к вопросу, на который он отвечает.
// Отсюда и живой баг: "нет" на "скинь инстаграм?" читалось как отказ от
// записи — для этого хватило бы и 2-3 обменов. 30 реплик (~15 обменов)
// взято шире: реальные диалоги легко доходят до 15-20 обменов, и кроме
// "на какой вопрос отвечает клиент" это ещё и живость/непрерывность —
// не начинать одинаково, не повторять то, что уже обсуждали чуть раньше
// (Аня, 22.08.2026). Факты (идея/размер/цена/телефон) всё равно живут в
// client_card навсегда — это окно только про то, как ЗВУЧИТ разговор
// прямо сейчас, не хранилище данных.
export const RECENT_HISTORY_TURNS_FOR_MODEL = 30;

export interface RecentDialogTurn {
  from: 'client' | 'inka';
  text: string;
}

// Урезанная версия истории для передачи в OpenAI — без ts (не нужен
// модели для этой задачи, только лишние токены).
export function recentDialogForModel(entries: DialogEntry[]): RecentDialogTurn[] {
  return entries.slice(-RECENT_HISTORY_TURNS_FOR_MODEL).map((e) => ({ from: e.from, text: e.text }));
}
