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
  // Нет прямой записи на тату: любой запрос про тату идёт на консультацию.
  consultationOnly: boolean;
  campaigns: CampaignConfig[];
  // Тексты профиля. Каждая функция читает свой файл литеральным путём —
  // Vercel трассирует только такие пути (см. ENOENT у Платона, PR #72).
  pricingRules: () => string;
  serviceScope: () => string;
  responderRules: () => string;
}
