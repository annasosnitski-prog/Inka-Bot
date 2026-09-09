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
import type { ClientCard, NextStep } from '../lib/stateMachine';
import type { RecentDialogTurn } from '../lib/dialogLog';

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
  nextStep: NextStep;
  lastClientMessage: string;
  recentHistory?: RecentDialogTurn[];
  // Проверка ответа: либо "должно быть упоминание сеанса/встречи"
  // (quote_price), либо произвольная функция для более сложных
  // сценариев (например "ответ реально касается количества встреч").
  check: (reply: string) => { ok: boolean; label: string };
}

const expectPeriodWord = (reply: string) => {
  const hasPeriodWord = /сеанс|встреч/i.test(reply);
  return { ok: hasPeriodWord, label: `упоминание "сеанс"/"встреча": ${hasPeriodWord ? 'есть' : 'НЕТ'}` };
};

const expectAnswersSessionCountQuestion = (reply: string) => {
  // Клиент спросил "а что если нужно больше одной встречи" — ответ
  // должен реально касаться темы (сеанс/встреча/несколько/зависит), а
  // не просто повторять канцелярский вопрос "хочешь записаться?" в
  // пустоту, игнорируя то, что клиент спросил.
  const addressesTopic = /сеанс|встреч|несколько|зависит|уточн|решит мастер/i.test(reply);
  return {
    ok: addressesTopic,
    label: `отвечает по теме количества встреч: ${addressesTopic ? 'да' : 'НЕТ — похоже, вопрос проигнорирован'}`,
  };
};

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
    nextStep: 'quote_price',
    lastClientMessage: 'сколько будет стоить?',
    check: expectPeriodWord,
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
    nextStep: 'quote_price',
    lastClientMessage: 'а сколько это будет стоить примерно?',
    check: expectPeriodWord,
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
    nextStep: 'quote_price',
    lastClientMessage: 'сколько стоит?',
    check: expectPeriodWord,
  },
  {
    name: 'D — после цены клиент спрашивает "а что если нужно больше одной встречи?" (не quote_price, а ask_wants_to_book)',
    card: baseCard({
      category: 'project',
      idea: 'плотная графика на спине и плече',
      size: 'спина+плечо',
      price_quoted: '2800',
      price_explained: 'no',
      direct_tattoo_allowed: 'no',
      consultation_needed: 'yes',
      price_shown: 'yes',
      wants_to_book: null,
    }),
    nextStep: 'ask_wants_to_book',
    recentHistory: [
      { from: 'client', text: 'сколько стоит?' },
      {
        from: 'inka',
        text: 'такая работа обычно около 2800₪ за встречу. тут считаются размер, плотность деталей и время на аккуратную работу.',
      },
    ],
    lastClientMessage: 'а что если нужно больше одной встречи?',
    check: expectAnswersSessionCountQuestion,
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
        nextStep: c.nextStep,
        clientCard: c.card,
        lastClientMessage: c.lastClientMessage,
        recentHistory: c.recentHistory ?? [],
        slotsDisplay: null,
      });
      console.log(`  Инка: ${reply}`);
      const { ok, label } = c.check(reply);
      console.log(`  ${ok ? 'PASS' : 'FAIL'} — ${label}`);
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
  console.log('ИТОГО: все сценарии прошли проверку.');
}

main();
