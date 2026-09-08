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

export function getPricingRules(): string {
  if (cachedRules) return cachedRules;
  const rulesPath = path.join(process.cwd(), 'lib', 'pricingRules.txt');
  cachedRules = fs.readFileSync(rulesPath, 'utf-8');
  return cachedRules;
}
