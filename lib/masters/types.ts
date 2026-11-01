import type { CampaignConfig } from '../campaigns';

// Всё, чем один мастер отличается от другого. Ядро (промпты в lib/prompts,
// state machine, telegram.ts) не знает имён мастеров и читает только это.
// Секреты и id деплоя (токены, MASTER_TELEGRAM_ID, GOOGLE_CALENDAR_ID,
// PAYMENT_BIT/BANK) остаются в env — они не про то, как мастер работает.
export interface MasterProfile {
  id: string;
  name: string;
  // "ассистентка тату-мастера Ани/Платона" — родительный падеж не выводится
  // из имени автоматически.
  nameGenitive: string;
  // "передала Платону", "куда Ане удобнее написать"
  nameDative: string;
  gender: 'female' | 'male';
  portfolioUrl: string | null;
  website: string | null;
  depositAmount: string;
  // Что Инка говорит про предоплату при записи на консультацию. Пустая
  // строка не допускается: если предоплаты через бота нет, это прямо
  // написано (бот про оплату молчит).
  consultationDepositNote: string;
  // Что мастер предлагает через бота (две независимые оси, новый мастер
  // выбирает комбинацию, код ядра не меняется):
  // consultationMode — как проходит консультация: 'chat' (по переписке) или
  //   'in_person' (очно). Пул слотов один ([ЧАТ], /добавить чат), клиенту слот
  //   показывается как "(по переписке)" или "(в студии)".
  // tattooBooking — кто записывает на сеанс: 'bot' (бот предлагает окна [ОКНО]
  //   на небольшие работы) или 'master' (мастер сам; любой запрос про тату
  //   идёт на консультацию).
  consultationMode: 'chat' | 'in_person';
  // Часовой пояс мастера (IANA). Нужен crons, которые шлют мастеру сводку в
  // его местное время (Vercel Cron работает только по UTC).
  timezone: string;
  tattooBooking: 'bot' | 'master';
  // true: мастер не делает цветной реализм. Модель описывает, что видит на
  // референсе, а код сразу ставит service_fit = not_offered
  // (lib/extractor.ts, applyColorRealismRule).
  excludesColorRealism: boolean;
  campaigns: CampaignConfig[];
  // Порог, до которого бот сам называет обоснованный итог по всему проекту.
  // Не потолок цены: дороже — бот сначала говорит цену сеанса и структуру
  // проекта, итог только по настойчивой просьбе (lib/prompts/responder.txt).
  totalEstimateDisclosureLimit: number;
  // Тексты профиля. Каждая функция читает свой файл литеральным путём —
  // Vercel трассирует только такие пути (см. ENOENT у Платона, PR #72).
  pricingRules: () => string;
  serviceScope: () => string;
  // Особые правила речи мастера сверх ядра. Пусто — особых правил нет.
  responderRules: () => string;
  // Подтверждённая ценность работы мастера: что входит в работу, даже если
  // не меняет цену. Единственное место для этих фактов.
  valueContext: () => string;
}
