// ============================================================
// Общая прайс-логика (категории/матрица/факторы трудоёмкости/примеры
// A-G) — единственный источник правды, живёт в pricingRules.txt.
// Раньше был вклеен только в extractorPrompt.txt, из-за чего Admin
// (свободный диалог с мастером) не знал, как считать цену, и просто
// гадал на вопрос "оцени по прайсу клиентскому". Теперь оба промпта
// подставляют один и тот же текст.
// ============================================================

import fs from 'fs';
import path from 'path';

let cachedRules: string | null = null;

// PRICING_PROFILE выбирает набор прайс-правил для деплоя: по умолчанию
// (не задан) — Аня, pricingRules.txt. "platon" — отдельный файл с его
// собственной логикой (зона/плотность вместо см-категорий), см.
// pricingRulesPlaton.txt. Другой деплой того же кода задаёт
// PRICING_PROFILE в окружении.
export function getPricingProfile(): string {
  return (process.env.PRICING_PROFILE ?? '').trim().toLowerCase();
}

export function getPricingRules(): string {
  if (cachedRules) return cachedRules;
  // Пути — литералы прямо в вызове readFileSync (как и в responder.ts/
  // extractor.ts/admin.ts): Next.js/Vercel трассирует файлы для серверless-
  // бандла статическим анализом и не видит путь, собранный через отдельную
  // функцию — из-за этого pricingRulesPlaton.txt не попадал в прод-бандл
  // (ENOENT у Платона).
  const rulesPath =
    getPricingProfile() === 'platon'
      ? path.join(process.cwd(), 'lib', 'pricingRulesPlaton.txt')
      : path.join(process.cwd(), 'lib', 'pricingRules.txt');
  cachedRules = fs.readFileSync(rulesPath, 'utf-8');
  return cachedRules;
}
