// Команды мастера /ссылка и /клиенты: чистые функции разбора периода и
// форматирования (без обращений к Airtable — их можно тестировать).
import { clientContactLinks, escapeHtml } from './telegramApi';

const DAY_MS = 86_400_000;
const MAX_LIST_LINES = 25;
const MAX_LIST_CHARS = 3800; // лимит Telegram — 4096

// Период из текста команды: "" / "все" → null (без ограничения);
// "7д", "7 дней", "7d", "неделя", "месяц", "сегодня" → число дней.
// Нераспознанное → undefined (вызывающий переспросит).
export function parseClientsPeriod(arg: string): number | null | undefined {
  const t = arg.trim().toLowerCase();
  if (!t || /^(все|всех|всё|all)$/.test(t)) return null;
  if (t === 'сегодня' || t === 'сутки') return 1;
  if (t === 'неделя' || t === 'неделю') return 7;
  if (t === 'месяц') return 30;
  const m = /^(\d{1,3})\s*(д|дн|дня|дней|день|d)?$/.exec(t);
  if (m) {
    const n = Number(m[1]);
    return n >= 1 ? n : undefined;
  }
  return undefined;
}

// telegram_id в Airtable — числовое поле («1234,0»); берём целое.
export function clientTelegramId(fields: Record<string, any>): number | null {
  const n = Math.trunc(Number(fields.telegram_id));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function clientDisplayName(fields: Record<string, any>): string {
  return escapeHtml(fields.name || (fields.username ? `@${fields.username}` : 'клиент'));
}

// Один клиент: имя + ссылки (HTML).
export function formatClientLinkLine(fields: Record<string, any>): string {
  const id = clientTelegramId(fields);
  const links = id ? clientContactLinks(id, fields.username ?? '', fields.phone ?? '') : 'нет telegram_id';
  return `• ${clientDisplayName(fields)} — ${links}`;
}

// Список клиентов (HTML). Записи ожидаются свежими первыми; один человек с
// несколькими проектами показывается один раз.
export function formatClientsList(records: Array<{ fields: Record<string, any> }>, days: number | null): string {
  const seen = new Set<number>();
  const unique = records.filter((r) => {
    const id = clientTelegramId(r.fields);
    if (id === null) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const title = days === null ? 'Все клиенты' : `Клиенты за ${days} дн.`;
  if (unique.length === 0) return `${title}: никого не нашла.`;
  const lines: string[] = [];
  let chars = 0;
  for (const r of unique.slice(0, MAX_LIST_LINES)) {
    const line = formatClientLinkLine(r.fields);
    if (chars + line.length > MAX_LIST_CHARS) break;
    lines.push(line);
    chars += line.length + 1;
  }
  const more = unique.length > lines.length ? `\n…и ещё ${unique.length - lines.length}. Сузь период: /клиенты 3д` : '';
  return `${title} (${unique.length}):\n${lines.join('\n')}${more}`;
}

export function periodCutoffMs(days: number | null, now = Date.now()): number | null {
  return days === null ? null : now - days * DAY_MS;
}
