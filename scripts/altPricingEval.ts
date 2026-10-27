// ============================================================
// INKA-BOT — Alt pricing (Платон) regression eval
// Аналог scripts/priceEval.ts для ALT_PRICING_RULES=true. НЕ часть
// `npm test` — ходит в живой OpenAI, печатает got vs expected для
// ручной проверки человеком. Цифры в expected — черновая калибровка
// из ТЗ "INKA / Платон — обратное ТЗ для Claude" (27.10.2026),
// НЕ подтверждены мастером (см. раздел 8 там же).
//
// Запуск (нужен OPENAI_API_KEY в окружении):
//   npx tsc scripts/altPricingEval.ts --outDir .eval-build --module commonjs \
//     --target es2020 --moduleResolution node --esModuleInterop \
//     --skipLibCheck --strict \
//   && node .eval-build/scripts/altPricingEval.js
//
// Покрывает тест-кейсы из раздела 11.3 ТЗ: малый проект до 6000,
// диапазон пересекает 6000, крупный проект + настойчивый запрос
// итога, референс "точь-в-точь", полурукав плечо vs предплечье,
// рёбра/живот без автонаценки, цветной акцент vs цветной реализм,
// недостаток данных.
// ============================================================

process.env.ALT_PRICING_RULES = 'true';

import { runExtractor, type ExtractorInput } from '../lib/extractor';
import { runResponder, type ResponderInput } from '../lib/responder';
import type { ClientCard } from '../lib/stateMachine';

interface Case {
  name: string;
  message: string;
  expected: string;
}

const emptyCard: Partial<ClientCard> = {};

function card(over: Partial<ClientCard> = {}): ClientCard {
  return {
    telegram_id: 1,
    intent: 'unclear',
    lead_status: 'new',
    category: null,
    idea: null,
    size: null,
    placement: null,
    first_tattoo: null,
    existing_tattoo: null,
    direct_tattoo_allowed: null,
    consultation_needed: null,
    active_work_time_estimate: null,
    price_quoted: null,
    price_explained: null,
    price_factors: null,
    price_shown: null,
    wants_to_book: null,
    decline_followup_asked: null,
    phone: null,
    client_name: null,
    contact_channel: null,
    social_link: null,
    social_asked: null,
    payment_status: null,
    client_type: null,
    skin_notes: null,
    spam_count: 0,
    chosen_slot_id: null,
    slot_options: null,
    booked_slot_display: null,
    booked_slot_start_iso: null,
    payment_reminder_sent: null,
    booked_at: null,
    payment_reminder_early_sent: null,
    reference_asked: null,
    photos_count: 0,
    has_photo_this_message: false,
    photo_has_caption: false,
    force_client_mode: null,
    service_fit: null,
    second_project_flagged: null,
    campaign_id: null,
    campaign_collected: null,
    campaign_handoff_sent: null,
    campaign_last_id: null,
    campaign_return_pending: null,
    ...over,
  };
}

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
    name: '1 — малый проект, итог реалистично до 6000₪',
    message:
      'Хочу абстрактный полурукав, только верх (от плеча до локтя), плотная ' +
      'чёрная заливка без декора, не плотный узор, примерно 2-3 встречи. Первая тату.',
    expected: 'price_quoted ≈2500₪/сеанс; price_factors ИТОГ_ОРИЕНТИР верхняя ≤6000₪ (сеансы ~2-3)',
  },
  {
    name: '2 — диапазон пересекает 6000₪ (полурукав, но ближе к верхней границе)',
    message:
      'Хочу абстрактный полурукав, плотная заливка + абстракция, высокая ' +
      'детализация, думаю понадобится 3-4 встречи, не знаю точно. Первая тату.',
    expected:
      'price_quoted ≈3000₪/сеанс; ИТОГ_ОРИЕНТИР может пересекать 6000₪ — ' +
      'Responder по умолчанию должен назвать общую сумму ТОЛЬКО если верхняя граница ≤6000₪',
  },
  {
    name: '3 — крупный проект (полный рукав) + клиент настойчиво просит итог',
    message:
      'Хочу полный рукав, тяжёлый блэкворк, дизайн разрабатывает мастер и ' +
      'делает freehand на теле. Скажи сразу, сколько весь рукав будет стоить в итоге, ' +
      'мне важно понимать общий бюджет, я уже два раза спрашиваю.',
    expected:
      'ИТОГ_ОРИЕНТИР верхняя > 6000₪ — Responder должен ОТКАЗАТЬСЯ сам предлагать итог, ' +
      'но настойчивый повторный вопрос клиента — дать широкий честный диапазон с оговорками',
  },
  {
    name: '4 — референс "точь-в-точь" на один референс-фото без доп. данных',
    message: 'Вот фото, хочу вот это ровно так же, один в один, без изменений.',
    expected:
      'price_explained="yes" (недостаточно данных по зоне/размеру); Responder по разделу 7 — ' +
      'не обещает точную сумму/число сеансов по одному референсу, не обесценивает вкус клиента',
  },
  {
    name: '5 — полурукав: плечо vs предплечье (разный прогноз сеансов, не цены за сеанс)',
    message:
      'Хочу полурукав, но именно плечо (от плеча до локтя сверху), плотная ' +
      'заливка средней детализации с абстракцией. Первая тату.',
    expected:
      'price_quoted по шкале плотность/детализация как обычно; price_factors может отметить ' +
      'что плечевой участок обычно требует МЕНЬШЕ сеансов, чем предплечье при схожей технике — ' +
      'это не должно менять price_quoted за сеанс',
  },
  {
    name: '6 — рёбра/живот без автоматической наценки',
    message:
      'Хочу тату на рёбрах и животе, плотная чёрная заливка, графика, ' +
      'средняя детализация. Первая тату.',
    expected:
      'price_quoted по той же шкале 2500-3700, БЕЗ автоматической наценки за рёбра/живот; ' +
      'price_factors должен упомянуть рёбра/живот как "зона повышенной сложности для оценки мастером"',
  },
  {
    name: '7 — цветной акцент vs цветной реализм (служебный, не на эту прайс-шкалу)',
    message:
      'Хочу тату на плече, в основном чёрное графика, но хочу небольшой ' +
      'красный акцент в паре мест. Первая тату.',
    expected: 'price_quoted по обычной шкале (локальный цветной акцент допустим)',
  },
  {
    name: '7b — цветной РЕАЛИЗМ (мастер не делает — должно отличаться от 7)',
    message:
      'Хочу портрет в полном цвете, реализм, яркие цвета, похоже на фотографию. Первая тату.',
    expected:
      'НЕ считать по этой шкале — мастер не делает цветной реализм; service_fit/заметка мастеру, ' +
      'НЕ давать price_quoted как если бы это обычный заказ этого мастера',
  },
  {
    name: '8 — недостаток данных (нет идеи, нет зоны, нет размера)',
    message: 'Привет! Хочу тату, но пока вообще не знаю что и где.',
    expected: 'category/price_quoted/price_explained остаются null — рано оценивать',
  },
];

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error(
      'OPENAI_API_KEY не задан в окружении — без него Extractor/Responder не могут вызвать OpenAI.\n' +
        'Прогнать этот eval можно только там, где есть боевой ключ (например локально у Ани).\n' +
        'Эти цифры — черновая калибровка из ТЗ Платона, не подтверждены мастером — прогон только для глаз.'
    );
    process.exit(1);
  }

  console.log('========================================');
  console.log('ALT PRICING EVAL (Платон) — контрольные примеры 1-8');
  console.log('========================================\n');

  for (const c of cases) {
    process.stdout.write(`▶ ${c.name}\n`);
    try {
      const extractorInput: ExtractorInput = { ...baseInput, messageText: c.message };
      const result = await runExtractor(extractorInput);
      console.log(`  category:              ${result.category}`);
      console.log(`  price_quoted:          ${result.price_quoted}`);
      console.log(`  price_explained:       ${result.price_explained}`);
      console.log(`  price_factors:         ${result.price_factors}`);
      console.log(`  service_fit:           ${result.service_fit} (${result.service_fit_reason})`);

      const clientCard = card(result);
      const responderInput: ResponderInput = {
        nextStep: 'quote_price',
        clientCard,
        lastClientMessage: c.message,
        recentHistory: [],
        slotsDisplay: null,
      };
      const reply = await runResponder(responderInput);
      console.log(`  ответ клиенту:         ${reply.replace(/\n/g, ' ')}`);
      console.log(`  ОЖИДАЕТСЯ:             ${c.expected}`);
    } catch (err) {
      console.log(`  ОШИБКА ВЫЗОВА: ${err instanceof Error ? err.message : String(err)}`);
    }
    console.log('');
  }
}

main();
