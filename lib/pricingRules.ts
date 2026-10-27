// ============================================================
// Общая прайс-логика (категории/матрица/факторы трудоёмкости/примеры
// A-G) — единственный источник правды, живёт в pricingRules.txt.
// Раньше был вклеен только в extractorPrompt.txt, из-за чего Admin
// (свободный диалог с мастером) не знал, как считать цену, и просто
// гадал на вопрос "оцени по прайсу клиентскому". Теперь оба промпта
// подставляют один и тот же текст.
//
// ALT_PRICING_RULES=true (другой деплой того же кода, мастер с
// принципиально другим прайсом — не см/категории, а весовые зоны +
// плотность/детализация, см. lib/altPricingRules.txt) — подставляет
// другой файл вместо базового, в то же место {{PRICING_RULES}} в
// extractorPrompt.txt и adminPrompt.txt. Anna's own deploy не
// устанавливает эту переменную, так что остаётся на базовых правилах.
// ============================================================

import fs from 'fs';
import path from 'path';

let cachedRules: string | null = null;
let cachedAltRules: string | null = null;

export function isAltPricing(): boolean {
  return (process.env.ALT_PRICING_RULES ?? '').trim().toLowerCase() === 'true';
}

export function getPricingRules(): string {
  if (isAltPricing()) {
    if (cachedAltRules) return cachedAltRules;
    const altRulesPath = path.join(process.cwd(), 'lib', 'altPricingRules.txt');
    cachedAltRules = fs.readFileSync(altRulesPath, 'utf-8');
    return cachedAltRules;
  }
  if (cachedRules) return cachedRules;
  const rulesPath = path.join(process.cwd(), 'lib', 'pricingRules.txt');
  cachedRules = fs.readFileSync(rulesPath, 'utf-8');
  return cachedRules;
}
