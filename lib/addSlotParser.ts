// ============================================================
// INKA-BOT — Admin: разбор команды /добавить (ШАГ 3)
// Чистый TypeScript, БЕЗ LLM — как state machine, детерминированный разбор
// защищает от того, что модель "угадает" не тот день/время для реального
// слота в календаре (ошибка здесь = неправильный слот, который увидят
// клиенты). Если формат не распознан — возвращаем понятную причину и
// просим переформулировать, а не гадаем.
// ============================================================

import type { SlotTag, SlotFamily } from './calendar';
import { familyOfTag, MAX_CONSULTATION_HOURS } from './calendar';

export interface ParsedAddSlot {
  ok: true;
  tag: SlotTag;
  date: string; // YYYY-MM-DD, календарная дата в Asia/Jerusalem
  startTime: string; // HH:MM
  endTime: string; // HH:MM
}
export interface ParseFailure {
  ok: false;
  error: string;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

// "Сегодня" по календарю Asia/Jerusalem, независимо от UTC-времени сервера.
function jerusalemToday(now: Date): string {
  return now.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }); // "YYYY-MM-DD"
}

// Чистая календарная арифметика над Y-M-D — не зависит от таймзоны/DST,
// т.к. мы не конвертируем время, только считаем дни от даты к дате.
function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function weekdayOf(ymd: string): number {
  return new Date(`${ymd}T00:00:00Z`).getUTCDay(); // 0=вс..6=сб
}

// Ближайшее вхождение дня недели, начиная С СЕГОДНЯ (если сегодня и есть
// искомый день — берём сегодня, а не через неделю).
function nextWeekday(now: Date, targetDay: number): string {
  const today = jerusalemToday(now);
  const diff = (targetDay - weekdayOf(today) + 7) % 7;
  return addDays(today, diff);
}

// ---- Тег слота ----
// Канонические теги в календаре — [ОКНО]/[ЧАТ] (см. lib/calendar.ts,
// удобны для голосового ввода). Старые слова WALKIN/ONLINE/конс/видео
// остаются РАСПОЗНАВАЕМЫМИ синонимами при вводе команды — Аня к ним
// привыкла, переучивать не нужно, они просто мапятся на новый тег.
// "видео" тут в частности осталась после переименования тега [ВИДЕО] →
// [ЧАТ] (2026-08-10, см. lib/calendar.ts) — старое слово всё ещё
// понимается при вводе, просто уже не название самого тега в календаре.
// Порядок важен: окно/walkin и чат/видео/online — более специфичные
// слова, проверяются раньше общих "тату"/"приём" (иначе "консультация
// онлайн" ушла бы в обычную [ПРИЁМ] вместо [ЧАТ]).
const TAG_PATTERNS: { re: RegExp; tag: SlotTag }[] = [
  { re: /окно|walk[\s-]?in|вок[\s-]?ин|волк[\s-]?ин|уок[\s-]?ин|олкин/i, tag: '[ОКНО]' },
  { re: /чат|видео|online|онлайн/i, tag: '[ЧАТ]' },
  { re: /тату|tattoo/i, tag: '[ТАТУ]' },
  { re: /приём|прием|конс|студи|очн/i, tag: '[ПРИЁМ]' },
];

export function findTag(text: string): SlotTag | null {
  for (const { re, tag } of TAG_PATTERNS) {
    if (re.test(text)) return tag;
  }
  return null;
}

// ВАЖНО: \b в JS-регулярках определяется через \w = [A-Za-z0-9_] — кириллица
// в \w НЕ входит. Значит \bзавтра\b НИКОГДА не матчится (между пробелом
// и "з" нет "границы слова" с точки зрения движка — с обеих сторон \W).
// Для кириллицы вместо \b используем lookaround на не-букву.
const CYR_BOUNDARY_BEFORE = '(?<![а-яёa-z])';
const CYR_BOUNDARY_AFTER = '(?![а-яёa-z])';
function cyrWord(word: string): RegExp {
  return new RegExp(`${CYR_BOUNDARY_BEFORE}${word}${CYR_BOUNDARY_AFTER}`, 'i');
}

// ---- Дата ----
const WEEKDAYS: { re: RegExp; day: number }[] = [
  { re: /воскресень/i, day: 0 },
  { re: cyrWord('вс'), day: 0 },
  { re: /понедельник/i, day: 1 },
  { re: cyrWord('пн'), day: 1 },
  { re: /вторник/i, day: 2 },
  { re: cyrWord('вт'), day: 2 },
  { re: /сред[ауы]/i, day: 3 },
  { re: cyrWord('ср'), day: 3 },
  { re: /четверг/i, day: 4 },
  { re: cyrWord('чт'), day: 4 },
  { re: /пятниц/i, day: 5 },
  { re: cyrWord('пт'), day: 5 },
  { re: /суббот/i, day: 6 },
  { re: cyrWord('сб'), day: 6 },
];

const MONTH_NAMES: Record<string, number> = {
  янв: 1, января: 1, январь: 1,
  фев: 2, февраля: 2, февраль: 2,
  март: 3, марта: 3,
  апр: 4, апреля: 4, апрель: 4,
  май: 5, мая: 5,
  июн: 6, июня: 6, июнь: 6,
  июл: 7, июля: 7, июль: 7,
  авг: 8, августа: 8, август: 8,
  сен: 9, сентября: 9, сентябрь: 9,
  окт: 10, октября: 10, октябрь: 10,
  ноя: 11, ноября: 11, ноябрь: 11,
  дек: 12, декабря: 12, декабрь: 12,
};

export function findDate(text: string, now: Date): string | null {
  const lower = text.toLowerCase();

  if (/послезавтра/.test(lower)) return addDays(jerusalemToday(now), 2);
  if (cyrWord('завтра').test(lower)) return addDays(jerusalemToday(now), 1);
  if (cyrWord('сегодня').test(lower)) return jerusalemToday(now);

  for (const { re, day } of WEEKDAYS) {
    if (re.test(lower)) return nextWeekday(now, day);
  }

  const today = jerusalemToday(now);
  const currentYear = Number(today.slice(0, 4));

  // "20.07" / "20.07.2026"
  const explicit = lower.match(/\b(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?\b/);
  if (explicit) {
    const day = parseInt(explicit[1], 10);
    const month = parseInt(explicit[2], 10);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      let year = explicit[3]
        ? (explicit[3].length === 2 ? 2000 + parseInt(explicit[3], 10) : parseInt(explicit[3], 10))
        : currentYear;
      let candidate = `${year}-${pad(month)}-${pad(day)}`;
      // Без явного года: если дата уже прошла в этом году — считаем, что
      // имелся в виду следующий год, а не прошлое.
      if (!explicit[3] && candidate < today) {
        year += 1;
        candidate = `${year}-${pad(month)}-${pad(day)}`;
      }
      return candidate;
    }
  }

  // "20 июля" — trailing \b намеренно опущен (см. комментарий выше про
  // \b и кириллицу); [а-яё]+ и так жадно захватывает весь непрерывный
  // кусок кириллицы, лишняя граница не нужна.
  const named = lower.match(/\b(\d{1,2})\s+([а-яё]+)/);
  if (named) {
    const day = parseInt(named[1], 10);
    const month = MONTH_NAMES[named[2]];
    if (month && day >= 1 && day <= 31) {
      let year = currentYear;
      let candidate = `${year}-${pad(month)}-${pad(day)}`;
      if (candidate < today) {
        year += 1;
        candidate = `${year}-${pad(month)}-${pad(day)}`;
      }
      return candidate;
    }
  }

  return null;
}

// ---- Время ----
// "12:00-14:00", "12:00–14:00" (en/em-dash), "12-14", "с 12 до 14",
// "с 12:00 до 14:00".
const TIME_RANGE_RE = /(?:с\s*)?(\d{1,2})(?::(\d{2}))?\s*(?:-|–|—|до)\s*(\d{1,2})(?::(\d{2}))?/;

export function findTimeRange(text: string): { startTime: string; endTime: string } | ParseFailure {
  const m = text.match(TIME_RANGE_RE);
  if (!m) {
    return { ok: false, error: 'не поняла время. формат: 12:00-14:00 (или «с 12 до 14»).' };
  }
  const h1 = parseInt(m[1], 10);
  const min1 = m[2] ? parseInt(m[2], 10) : 0;
  const h2 = parseInt(m[3], 10);
  const min2 = m[4] ? parseInt(m[4], 10) : 0;
  if (h1 > 23 || h2 > 23 || min1 > 59 || min2 > 59) {
    return { ok: false, error: 'странное время — проверь часы/минуты.' };
  }
  const startTime = `${pad(h1)}:${pad(min1)}`;
  const endTime = `${pad(h2)}:${pad(min2)}`;
  if (endTime <= startTime) {
    return { ok: false, error: 'конец должен быть позже начала.' };
  }
  return { startTime, endTime };
}

// ---- Главная функция ----
export function parseAddSlotCommand(text: string, now: Date): ParsedAddSlot | ParseFailure {
  const tag = findTag(text);
  if (!tag) {
    return { ok: false, error: 'не поняла тип слота. напиши: чат / окно.' };
  }
  // [ТАТУ]/[ПРИЁМ] — это Дневник-сессии мастера с реальным клиентом, бот их
  // никогда не предлагает в чате (см. tagsForRequest в lib/calendar.ts).
  // /добавить создаёт ТОЛЬКО открытый пул для новых клиентов — ОКНО/ЧАТ.
  if (tag === '[ТАТУ]' || tag === '[ПРИЁМ]') {
    return {
      ok: false,
      error: `${tag} — это Дневник-сессия с конкретным клиентом, бот такое не предлагает. Для открытого слота новому клиенту напиши: окно (тату) или чат (приём).`,
    };
  }

  const time = findTimeRange(text);
  if ('error' in time) return time;

  const date = findDate(text, now);
  if (!date) {
    return {
      ok: false,
      error: 'не поняла дату. напиши день недели («пятница»), «завтра» или число («20.07» / «20 июля»).',
    };
  }

  return { ok: true, tag, date, startTime: time.startTime, endTime: time.endTime };
}

const DATE_ERROR = 'не поняла дату. напиши день недели («пятница»), «завтра» или число («20.07» / «20 июля»).';

// Лучшее усилие: вычищает из текста уже распознанные тег/дату/время —
// то, что осталось (если что-то осталось) считаем именем "для памяти".
// Не критично для /закрой (просто подпись в календаре), для /удалить
// используется как доп. фильтр — при неудачном вычищении просто найдётся
// больше кандидатов и бот попросит уточнить, а не удалит не то.
function extractName(text: string, tag: SlotTag, timeRange: { startTime: string; endTime: string } | null): string | null {
  let s = text;
  const tagPattern = TAG_PATTERNS.find((p) => p.tag === tag);
  if (tagPattern) s = s.replace(tagPattern.re, ' ');
  s = s.replace(/послезавтра/i, ' ');
  s = s.replace(cyrWord('завтра'), ' ');
  s = s.replace(cyrWord('сегодня'), ' ');
  for (const { re } of WEEKDAYS) s = s.replace(re, ' ');
  s = s.replace(/\b\d{1,2}\.\d{1,2}(?:\.\d{2,4})?\b/, ' ');
  s = s.replace(/\b\d{1,2}\s+[а-яё]+\b/i, ' ');
  if (timeRange) s = s.replace(TIME_RANGE_RE, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s || null;
}

// ---- /закрой ----
// Время ОБЯЗАТЕЛЬНО для обоих типов — "весь день" для консультации не
// бывает (максимум встречи — MAX_CONSULTATION_HOURS, дальше ошибка).
// Для тату "весь день" получается не флагом, а следствием: ≥4ч в
// диапазоне дальше подхватит TATTOO_DAY_BLOCK_HOURS в computeDayBlockInfo
// (lib/calendar.ts) и заблокирует весь день целиком, короче — только
// это окно.
export interface ParsedClose {
  ok: true;
  family: SlotFamily;
  date: string;
  timeRange: { startTime: string; endTime: string };
  name: string | null;
}

export function parseCloseCommand(text: string, now: Date): ParsedClose | ParseFailure {
  const tag = findTag(text);
  if (!tag) {
    return { ok: false, error: 'не поняла что закрыть. напиши: тату или приём (можно и чат/окно).' };
  }
  const family = familyOfTag(tag);

  const date = findDate(text, now);
  if (!date) return { ok: false, error: DATE_ERROR };

  const time = findTimeRange(text);
  if ('error' in time) return time;

  if (family === 'consultation') {
    const [h1, m1] = time.startTime.split(':').map(Number);
    const [h2, m2] = time.endTime.split(':').map(Number);
    const hours = (h2 * 60 + m2 - (h1 * 60 + m1)) / 60;
    if (hours > MAX_CONSULTATION_HOURS) {
      return { ok: false, error: `консультация не бывает длиннее ${MAX_CONSULTATION_HOURS}ч — проверь время.` };
    }
  }

  const name = extractName(text, tag, time);
  return { ok: true, family, date, timeRange: time, name };
}

// ---- /удалить ----
// Дата+семья находят кандидатов через findEventsOnDate (lib/calendar.ts);
// имя (если распозналось) дополнительно фильтрует. Найдётся больше одной
// записи — просим уточнить, ничего не удаляем вслепую.
export interface ParsedDelete {
  ok: true;
  family: SlotFamily;
  date: string;
  name: string | null;
}

export function parseDeleteCommand(text: string, now: Date): ParsedDelete | ParseFailure {
  const tag = findTag(text);
  if (!tag) {
    return { ok: false, error: 'не поняла что удалить. напиши: тату или приём (можно и чат/окно).' };
  }
  const family = familyOfTag(tag);

  const date = findDate(text, now);
  if (!date) return { ok: false, error: DATE_ERROR };

  const name = extractName(text, tag, null);
  return { ok: true, family, date, name };
}
