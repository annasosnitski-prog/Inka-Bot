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
  gender: 'female' | 'male';
  portfolioUrl: string | null;
  website: string | null;
  depositAmount: string;
  // Что Инка говорит про предоплату при записи на консультацию. Пустая
  // строка не допускается: если предоплаты через бота нет, это прямо
  // написано (бот про оплату молчит).
  consultationDepositNote: string;
  // Нет прямой записи на тату: любой запрос про тату идёт на консультацию.
  consultationOnly: boolean;
  // Консультация проходит очно: пул слотов тот же ([ЧАТ], /добавить чат), но
  // клиенту слот показывается как "(в студии)", а не "(по переписке)".
  consultationInPerson: boolean;
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
