// ============================================================
// INKA-BOT — Price regression eval, деплой Платона (PRICING_PROFILE=platon)
// НЕ часть `npm test`, см. комментарий в scripts/priceEval.ts — тот же
// принцип: ценовая логика живёт в промпте (lib/pricingRulesPlaton.txt),
// единственный способ её реально проверить — прогнать через настоящий
// Extractor с живым OpenAI-ключом.
//
// Запуск: PRICING_PROFILE=platon OPENAI_API_KEY=... npm run eval:price:platon
// ============================================================

process.env.PRICING_PROFILE = 'platon';
process.env.CONSULTATION_ONLY = 'true';

import { runExtractor, type ExtractorInput } from '../lib/extractor';
import type { ClientCard } from '../lib/stateMachine';

interface Case {
  name: string;
  message: string;
  expected: string;
}

const emptyCard: Partial<ClientCard> = {};

const baseInput: Omit<ExtractorInput, 'messageText'> = {
  currentCard: emptyCard,
  hasPhoto: false,
  photoCaption: null,
  isAdminSender: false,
  recentHistory: [],
  photoFileId: null,
};

const cases: Case[] = [
  {
    name: '1 — полный рукав, ботаника в плотном чёрном',
    message:
      'Хочу полный рукав, ботаника, плотный чёрный блэкворк без просветов. Место чистое, первая тату.',
    expected: 'category=project, ≈3000₪/сеанс',
  },
  {
    name: '2а — спина + задняя шея, абстракция, много негатива',
    message:
      'Хочу всю спину и заднюю шею, абстрактная композиция с большим количеством негативного пространства, воздушно. Место чистое, первая тату.',
    expected: 'category=project, ≈3300₪/сеанс, ориентир 10–14 сеансов',
  },
  {
    name: '3 — полурукав, чёрный с круглыми просветами',
    message:
      'Хочу полурукав, плотный чёрный с круглыми просветами внутри. Место чистое, первая тату.',
    expected: 'category=large, ≈2800₪/сеанс, ориентир 2–4 сеанса',
  },
  {
    name: '5 — грудь, графика на чёрной базе + локальный красный акцент (цветной акцент, не цветной реализм)',
    message:
      'Хочу тату на всю грудь, чёрная графика, и один небольшой красный акцент в композиции. Не реализм. Место чистое, первая тату.',
    expected:
      'category=project, ≈3200₪/сеанс — цветной акцент допустим стилем, это НЕ отказ (не цветной реализм)',
  },
  {
    name: '8 — плечо плотное чёрное vs предплечье воздушное (разная плотность в одной руке)',
    message:
      'Хочу полный рукав: плечо залить плотным чёрным без декора, а предплечье — воздушная абстрактная графика с негативным пространством. Место чистое, первая тату.',
    expected:
      'category=project, ≈2850₪/сеанс (смешанная цена — плечо дешевле/плотнее, предплечье дороже/воздушнее)',
  },
  {
    name: '12 — полный рукав, ч/б реализм на чёрной базе (потолок шкалы)',
    message:
      'Хочу полный рукав, чёрно-белый реализм (пионы) на чёрной базе, высокая детализация. Место чистое, первая тату.',
    expected: 'category=project, ≈3700₪/сеанс (потолок), черновой ориентир 6–10 сеансов',
  },
  {
    name: 'REF — цветной реализм как ОСНОВА (отказ по стилю, цвет не акцент)',
    message:
      'Хочу цветной реализм — портрет в цвете на всю руку, прям фотореалистично. Место чистое, первая тату.',
    expected:
      'НЕ делает цветной реализм КАК ОСНОВУ — service_fit должен быть "not_offered"/needs_clarification',
  },
  {
    name: 'РЕАЛИЗМ НА ЧЁРНОЙ БАЗЕ — настойчивая просьба именно реализма (service_fit=allowed, это НЕ "вне направления")',
    message:
      'Я прям настаиваю именно на реализме, фотографическая точность важна. Пусть будет ч/б реализм, портрет на чёрном фоне, полный рукав. Место чистое, первая тату.',
    expected:
      'category=project, ≈3500-3700₪/сеанс — реализм САМ ПО СЕБЕ не "вне направления" для Платона, service_fit=allowed (не not_offered)',
  },
  {
    name: 'РЁБРА/ЖИВОТ — без автоматической наценки',
    message:
      'Хочу тату на рёбрах и животе, плотный чёрный блэкворк без декора. Место чистое, первая тату.',
    expected:
      'category=project/large, ≈2500-2800₪/сеанс база по плотности — НЕ должно быть автоматической наценки только за зону рёбра/живот, price_factors может пометить зону как требующую оценки мастера',
  },
  {
    name: 'НЕДОСТАТОК ДАННЫХ — мало деталей',
    message: 'Привет! Хочу тату у Платона, подскажите цену?',
    expected: 'category=null, price_quoted=null — данных мало, не угадывать',
  },
];

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error(
      'OPENAI_API_KEY не задан в окружении — без него Extractor не может вызвать OpenAI.'
    );
    process.exit(1);
  }

  console.log('========================================');
  console.log('PRICE EVAL — ПЛАТОН (PRICING_PROFILE=platon)');
  console.log('========================================\n');

  for (const c of cases) {
    process.stdout.write(`▶ ${c.name}\n`);
    try {
      const result = await runExtractor({ ...baseInput, messageText: c.message });
      console.log(`  category:              ${result.category}`);
      console.log(`  price_quoted:          ${result.price_quoted}`);
      console.log(`  price_explained:       ${result.price_explained}`);
      console.log(`  price_factors:         ${result.price_factors}`);
      console.log(`  service_fit:           ${result.service_fit}`);
      console.log(`  direct_tattoo_allowed: ${result.direct_tattoo_allowed}`);
      console.log(`  consultation_needed:   ${result.consultation_needed}`);
      console.log(`  ОЖИДАЕТСЯ:             ${c.expected}`);
    } catch (err) {
      console.log(`  ОШИБКА ВЫЗОВА: ${err instanceof Error ? err.message : String(err)}`);
    }
    console.log('');
  }
}

main();
