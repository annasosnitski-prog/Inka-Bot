// ============================================================
// INKA-BOT — Dialog eval (Responder)
// НЕ часть `npm test`. Прогоняет несколько реалистичных карточек
// клиента через настоящий Responder (нужен OPENAI_API_KEY) и
// печатает, что реально увидел бы клиент — плюс проверяет, что цена
// всегда явно помечена "за сеанс"/"за встречу" (баг из прода: цена
// без этой пометки читалась как цена за весь проект).
//
// Запуск: OPENAI_API_KEY=... npm run eval:dialog
// ============================================================

import { runResponder } from '../lib/responder';
import type { ClientCard } from '../lib/stateMachine';

function baseCard(over: Partial<ClientCard> = {}): ClientCard {
  return {
    telegram_id: 1,
    intent: 'booking',
    lead_status: 'estimated',
    category: 'small',
    idea: 'роза',
    size: '10см',
    placement: 'предплечье',
    first_tattoo: 'yes',
    existing_tattoo: 'no',
    direct_tattoo_allowed: 'yes',
    consultation_needed: 'no',
    active_work_time_estimate: '<=3h',
    price_quoted: '800₪',
    price_explained: 'yes',
    price_factors: null,
    price_shown: 'no',
    wants_to_book: null,
    phone: null,
    decline_followup_asked: null,
    client_name: 'Тест',
    contact_channel: 'telegram',
    social_link: null,
    social_asked: 'yes',
    reference_asked: 'yes',
    payment_status: null,
    client_type: '2_reference',
    skin_notes: null,
    spam_count: 0,
    chosen_slot_id: null,
    slot_options: ['ev1', 'ev2'],
    booked_slot_display: null,
    booked_slot_start_iso: null,
    payment_reminder_sent: null,
    photos_count: 0,
    has_photo_this_message: false,
    photo_has_caption: false,
    force_client_mode: null,
    booked_at: null,
    payment_reminder_early_sent: null,
    ...over,
  };
}

interface Case {
  name: string;
  card: ClientCard;
  lastClientMessage: string;
  expectPeriodWord: boolean; // ожидаем ли "сеанс"/"встреч" в ответе
}

const cases: Case[] = [
  {
    name: 'A — прямая цена, medium, price_explained=no (обычный клиент)',
    card: baseCard({
      category: 'medium',
      idea: 'графика на предплечье',
      size: '12см',
      price_quoted: '900-1100',
      price_explained: 'no',
      direct_tattoo_allowed: 'yes',
      consultation_needed: 'no',
    }),
    lastClientMessage: 'сколько будет стоить?',
    expectPeriodWord: true,
  },
  {
    name: 'B — крупный проект, price_explained=yes (ожидаемый путь)',
    card: baseCard({
      category: 'project',
      idea: 'рукав, воздушная композиция',
      size: 'вся рука',
      price_quoted: '2400',
      price_explained: 'yes',
      direct_tattoo_allowed: 'no',
      consultation_needed: 'yes',
    }),
    lastClientMessage: 'а сколько это будет стоить примерно?',
    expectPeriodWord: true,
  },
  {
    name: 'C — крупный проект, но price_explained=no (баг-сценарий из прода: Extractor не проставил price_explained)',
    card: baseCard({
      category: 'project',
      idea: 'плотная графика на спине и плече',
      size: 'спина+плечо',
      price_quoted: '2800',
      price_explained: 'no',
      direct_tattoo_allowed: 'no',
      consultation_needed: 'yes',
    }),
    lastClientMessage: 'сколько стоит?',
    expectPeriodWord: true,
  },
];

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error(
      'OPENAI_API_KEY не задан в окружении — без него Responder не может вызвать OpenAI.'
    );
    process.exit(1);
  }

  console.log('========================================');
  console.log('DIALOG EVAL — Responder, quote_price');
  console.log('========================================\n');

  let anyMissing = false;

  for (const c of cases) {
    process.stdout.write(`▶ ${c.name}\n`);
    console.log(`  клиент: "${c.lastClientMessage}"`);
    try {
      const reply = await runResponder({
        nextStep: 'quote_price',
        clientCard: c.card,
        lastClientMessage: c.lastClientMessage,
        recentHistory: [],
        slotsDisplay: null,
      });
      console.log(`  Инка: ${reply}`);
      const hasPeriodWord = /сеанс|встреч/i.test(reply);
      const ok = hasPeriodWord === c.expectPeriodWord;
      console.log(
        `  ${ok ? 'PASS' : 'FAIL'} — упоминание "сеанс"/"встреча": ${hasPeriodWord ? 'есть' : 'НЕТ'}`
      );
      if (!ok) anyMissing = true;
    } catch (err) {
      console.log(`  ОШИБКА ВЫЗОВА: ${err instanceof Error ? err.message : String(err)}`);
      anyMissing = true;
    }
    console.log('');
  }

  if (anyMissing) {
    console.log('ИТОГО: есть проблемы — см. FAIL/ОШИБКА выше.');
    process.exit(1);
  }
  console.log('ИТОГО: все сценарии называют цену с "за сеанс"/"за встречу".');
}

main();
