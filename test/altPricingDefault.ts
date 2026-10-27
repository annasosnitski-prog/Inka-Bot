// ============================================================
// INKA-BOT — alt pricing plumbing self-test, ALT_PRICING_RULES НЕ задан.
// Детерминированная проверка, без сети/LLM: убеждаемся, что базовый
// (Аня) деплой продолжает получать прежний прайс-текст, когда новая
// переменная окружения не установлена. См. test/altPricingAlt.ts для
// противоположного сценария (отдельный процесс — обе переменные кэшируют
// файл на уровне модуля, поэтому один процесс = одно состояние флага).
// ============================================================

import { getPricingRules, isAltPricing } from '../lib/pricingRules';

let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('\n▶ ALT_PRICING_RULES не задан — базовый прайс Ани не меняется');
ok('isAltPricing() === false по умолчанию', isAltPricing() === false);
ok(
  'getPricingRules() возвращает базовые см-категории',
  getPricingRules().includes('mini        — до 3×3 см')
);
ok(
  'getPricingRules() НЕ содержит прайс-текст Платона по умолчанию',
  !getPricingRules().includes('ИТОГ_ОРИЕНТИР')
);

console.log(`\n${'='.repeat(40)}`);
console.log(`ИТОГО: ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));
process.exit(failed > 0 ? 1 : 0);
