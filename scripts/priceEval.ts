// ============================================================
// INKA-BOT — Price regression eval
// НЕ часть `npm test` (test/selftest.ts принципиально не дёргает LLM —
// см. комментарий там). Вся ценовая логика живёт в extractorPrompt.txt
// как инструкция для модели, а не в детерминированном коде — поэтому
// единственный способ реально проверить калибровку это прогнать
// контрольные примеры через настоящий Extractor с живым OpenAI-ключом.
//
// Запуск (нужен OPENAI_API_KEY в окружении):
//   npx tsc scripts/priceEval.ts --outDir .eval-build --module commonjs \
//     --target es2020 --moduleResolution node --esModuleInterop \
//     --skipLibCheck --strict \
//   && node .eval-build/scripts/priceEval.js
// или через npm run eval:price (см. package.json).
//
// Печатает got vs expected по каждому контрольному примеру A-G из
// задачи "Обновить прайс-логику INKA" — ручная проверка после правки
// extractorPrompt.txt, не автоматический gate в CI.
// ============================================================

import { runExtractor, type ExtractorInput } from '../lib/extractor';
import type { ClientCard } from '../lib/stateMachine';

interface Case {
  name: string;
  message: string;
  expected: string; // диапазон/ориентир из ТЗ, для глаз человека, не для авто-сравнения
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
    name: 'A — предплечье 15-18см, цветная графика, средняя плотность, не freehand',
    message:
      'Хочу тату на предплечье, где-то 15-18 см, цветная графика, детали средние, ' +
      'без фрихенда — просто перенос готового дизайна по трафарету. Место чистое, первая тату.',
    expected: '1200-1500₪, ориентир 1400₪',
  },
  {
    name: 'B — голень 12-15см, ч/б воздушная графика, средняя плотность',
    message:
      'Хочу тату на голени, примерно 12-15 см, чёрно-белая воздушная графика, ' +
      'средняя детализация, не плотная. Место чистое, первая тату.',
    expected: '900-1100₪, ориентир 1000₪',
  },
  {
    name: 'C — до 10см, плотная цветная графика, несколько детализированных элементов',
    message:
      'Хочу тату до 10 см, но очень плотная цветная графика, несколько ' +
      'мелких детализированных элементов внутри. Место чистое, первая тату.',
    expected: '800-1000₪, ориентир 900₪',
  },
  {
    name: 'D1 — большая воздушная freehand-композиция, рука+плечо (один блок)',
    message:
      'Хочу большую татуировку от кисти до плеча (вся рука), воздушная ' +
      'авторская композиция, дизайн разрабатывает мастер и делает полностью ' +
      'на теле freehand, без трафарета. Работа не плотная, воздушная. Место чистое, первая тату.',
    expected: '≈2400₪ (один блок)',
  },
  {
    name: 'D2 — то же + продолжение отдельным блоком на лопатку/верх спины',
    message:
      'Хочу большую татуировку от кисти до плеча (вся рука), воздушная ' +
      'авторская композиция, дизайн разрабатывает мастер и делает полностью ' +
      'на теле freehand, без трафарета, и хочу продолжить эту же композицию ' +
      'отдельным крупным блоком на лопатку и верх спины. Место чистое, первая тату.',
    expected: '≈4800₪ (два блока)',
  },
  {
    name: 'E — высокоплотная графика на спине/лопатке/плече, несколько сессий',
    message:
      'Хочу очень плотную детализированную графическую работу на спине, ' +
      'лопатке и плече — много внутренних линий, штриховки, мелких элементов, ' +
      'большая площадь. Понимаю, что это несколько сеансов. Место чистое, первая тату.',
    expected: '≈10 000₪',
  },
  {
    name: 'F — 360° голень, тяжёлый blackwork + design + full freehand',
    message:
      'Хочу татуировку кругом, по всей окружности голени, почти от колена ' +
      'до щиколотки, тяжёлый плотный blackwork, дизайн разрабатывает мастер ' +
      'и делает полностью на теле freehand, без трафарета. Место чистое, первая тату.',
    expected: '5500-7000₪, ориентир 6200₪',
  },
  {
    name: 'G — крупная красная графика на грудине/под грудью/рёбрах, design, не freehand',
    message:
      'Хочу крупную татуировку красным цветом на грудине, под грудью и на ' +
      'рёбрах, дизайн разрабатывает мастер, но переносит по трафарету, не ' +
      'freehand. Линии широкие, плотно прокрашенные, насыщенный цвет. Место чистое, первая тату.',
    expected: '3200-3800₪, ориентир 3500₪',
  },
];

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error(
      'OPENAI_API_KEY не задан в окружении — без него Extractor не может вызвать OpenAI.\n' +
        'Прогнать этот eval можно только там, где есть боевой ключ (например локально у Ани).'
    );
    process.exit(1);
  }

  console.log('========================================');
  console.log('PRICE EVAL — контрольные примеры A-G');
  console.log('========================================\n');

  for (const c of cases) {
    process.stdout.write(`▶ ${c.name}\n`);
    try {
      const result = await runExtractor({ ...baseInput, messageText: c.message });
      console.log(`  category:              ${result.category}`);
      console.log(`  price_quoted:          ${result.price_quoted}`);
      console.log(`  price_explained:       ${result.price_explained}`);
      console.log(`  price_factors:         ${result.price_factors}`);
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
