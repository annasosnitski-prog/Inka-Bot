// ============================================================
// INKA-BOT — alt pricing plumbing self-test, ALT_PRICING_RULES=true.
// Детерминированная проверка, без сети/LLM: убеждаемся, что при
// установленной переменной Extractor/Admin получают прайс-текст
// Платона вместо базовых см-категорий, а responder-оверлей существует
// и ссылается на ту же метку ("ИТОГ_ОРИЕНТИР"), которую пишет Extractor
// — иначе Responder не сможет прочитать порог 6000₪ из price_factors.
// process.env устанавливается ДО импорта lib/pricingRules, т.к. его
// результат кэшируется на уровне модуля при первом вызове.
// ============================================================

process.env.ALT_PRICING_RULES = 'true';

import fs from 'fs';
import path from 'path';
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

console.log('\n▶ ALT_PRICING_RULES=true — прайс Платона подставляется вместо базового');
ok('isAltPricing() === true', isAltPricing() === true);
const rules = getPricingRules();
ok('getPricingRules() содержит шкалу Платона (ИТОГ_ОРИЕНТИР)', rules.includes('ИТОГ_ОРИЕНТИР'));
ok(
  'getPricingRules() НЕ содержит базовую см-матрицу Ани под альт-режимом',
  !rules.includes('mini        — до 3×3 см')
);
ok('getPricingRules() содержит потолок шкалы 3700₪', rules.includes('3700₪'));

console.log('\n▶ Extractor и Responder оверлеи согласованы по метке ИТОГ_ОРИЕНТИР');
const responderOverlay = fs.readFileSync(
  path.join(process.cwd(), 'lib', 'altPricingResponderOverlay.txt'),
  'utf-8'
);
ok(
  'responder-оверлей знает метку ИТОГ_ОРИЕНТИР, которую пишет extractor',
  responderOverlay.includes('ИТОГ_ОРИЕНТИР')
);
ok('responder-оверлей содержит порог 6000₪ из ТЗ', responderOverlay.includes('6000'));

console.log(`\n${'='.repeat(40)}`);
console.log(`ИТОГО: ${passed} passed, ${failed} failed`);
console.log('='.repeat(40));
process.exit(failed > 0 ? 1 : 0);
