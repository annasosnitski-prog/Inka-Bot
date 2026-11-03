// ============================================================
// INKA-BOT — ежедневные сводки мастеру (pages/api/unfinished-dialogs.ts,
// та же cron-джоба шлёт обе): начатые, но не завершённые диалоги, и новые
// брони за сутки. Чистая логика вынесена сюда, чтобы покрыть тестами: роут
// завязан на Airtable/Telegram.
//
// Сводки — для всех мастеров одинаковые (ядро), время отправки — 10:00
// по часовому поясу профиля мастера.
// ============================================================

// Статусы, в которых диалог начат, но не завершён: ни брони, ни блока.
export const UNFINISHED_LEAD_STATUSES = [
  'new',
  'diagnosing',
  'estimated',
  'wants_booking',
  'slots_shown',
  'slots_shown_clarifying',
  'waiting_slots',
  'waiting_slots_pinged',
] as const;

export const DIGEST_LOCAL_HOUR = 10;
// Берём диалоги с активностью за последние сутки: у каждого диалога тогда
// ровно одна сводка, без повторов день за днём.
export const DIGEST_WINDOW_HOURS = 24;
const MAX_LINES = 20;

const STATUS_LABELS: Record<string, string> = {
  new: 'только начал(а) разговор',
  diagnosing: 'уточняет идею',
  estimated: 'узнал(а) цену, не решил(а)',
  wants_booking: 'хочет записаться, не дошёл(а) до времени',
  slots_shown: 'видел(а) слоты, не выбрал(а)',
  slots_shown_clarifying: 'отказался(лась) от слотов, уточняем',
  waiting_slots: 'ждёт слот',
  waiting_slots_pinged: 'ждёт слот (уже писали)',
};

export function localHour(now: Date, timeZone: string): number {
  const h = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone })
    .formatToParts(now)
    .find((p) => p.type === 'hour')?.value;
  const n = Number(h);
  return n === 24 ? 0 : n;
}

export function isDigestHour(now: Date, timeZone: string): boolean {
  return localHour(now, timeZone) === DIGEST_LOCAL_HOUR;
}

export function buildUnfinishedDialogsDigest(
  records: { fields: Record<string, any> }[],
  now: Date
): string | null {
  const rows: { hours: number; line: string }[] = [];
  for (const r of records) {
    const f = r.fields;
    if (!(UNFINISHED_LEAD_STATUSES as readonly string[]).includes(f.lead_status ?? 'new')) continue;
    const t = f.updated_at ? new Date(f.updated_at).getTime() : NaN;
    if (!Number.isFinite(t)) continue;
    const hours = (now.getTime() - t) / 3_600_000;
    if (hours < 0 || hours > DIGEST_WINDOW_HOURS) continue;

    const who = f.name
      ? `${f.name}${f.username ? ` (@${f.username})` : ''}`
      : f.username
      ? `@${f.username}`
      : 'клиент';
    const status = STATUS_LABELS[f.lead_status ?? 'new'] ?? 'в диалоге';
    const price = f.price_quoted ? `, цена ${f.price_quoted}₪` : '';
    const phone = f.phone ? `, тел. ${f.phone}` : '';
    rows.push({ hours, line: `• ${who} — ${status}${price}${phone}, молчит ~${Math.round(hours)}ч` });
  }
  if (rows.length === 0) return null;
  rows.sort((a, b) => a.hours - b.hours);
  const shown = rows.slice(0, MAX_LINES).map((r) => r.line);
  const more = rows.length > MAX_LINES ? `\n…и ещё ${rows.length - MAX_LINES}` : '';
  return `🗂 Начатые диалоги за сутки без записи (${rows.length}):\n${shown.join('\n')}${more}\nМожет, кому-то стоит написать лично.`;
}

const BOOKING_TYPE_LABELS: Record<string, string> = {
  tattoo_booked_waiting_payment: 'тату',
  consultation_booked: 'консультация',
};

// Новые брони за сутки (тату и консультации). Окно — по booked_at (момент
// самой брони), не updated_at — иначе бронь "потеряется" из сводки, если
// клиент потом написал что-то ещё и обновил updated_at за пределами окна,
// или наоборот будет напоминать о себе каждый день, пока клиент молчит.
export function buildNewBookingsDigest(
  records: { fields: Record<string, any> }[],
  now: Date
): string | null {
  const rows: { bookedAt: number; line: string }[] = [];
  for (const r of records) {
    const f = r.fields;
    const type = BOOKING_TYPE_LABELS[f.lead_status as string];
    if (!type) continue;
    const t = f.booked_at ? new Date(f.booked_at).getTime() : NaN;
    if (!Number.isFinite(t)) continue;
    const hours = (now.getTime() - t) / 3_600_000;
    if (hours < 0 || hours > DIGEST_WINDOW_HOURS) continue;

    const who = f.name
      ? `${f.name}${f.username ? ` (@${f.username})` : ''}`
      : f.username
      ? `@${f.username}`
      : 'клиент';
    const slot = f.booked_slot_display ? `, ${f.booked_slot_display}` : '';
    const phone = f.phone ? `, тел. ${f.phone}` : '';
    rows.push({ bookedAt: t, line: `• ${who} — ${type}${slot}${phone}` });
  }
  if (rows.length === 0) return null;
  rows.sort((a, b) => a.bookedAt - b.bookedAt);
  const shown = rows.slice(0, MAX_LINES).map((r) => r.line);
  const more = rows.length > MAX_LINES ? `\n…и ещё ${rows.length - MAX_LINES}` : '';
  return `✅ Новые записи за сутки (${rows.length}):\n${shown.join('\n')}${more}`;
}
