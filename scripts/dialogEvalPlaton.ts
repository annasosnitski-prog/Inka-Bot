// ============================================================
// INKA-BOT — Dialog eval, профиль Платона (MASTER_PROFILE=platon)
// НЕ часть `npm test`: правило раскрытия общей суммы, голос про референс
// (lib/masters/platon/responder.txt) и разговор о цене (КОММЕРСАНТ в
// lib/prompts/responder.txt) — инструкции для модели, проверяются только
// живым вызовом Responder.
//
// Запуск: OPENAI_API_KEY=... npm run eval:dialog:platon
// ============================================================

process.env.MASTER_PROFILE = 'platon';

import { runResponder } from '../lib/responder';
import type { ClientCard, NextStep } from '../lib/stateMachine';
import type { RecentDialogTurn } from '../lib/dialogLog';

function baseCard(over: Partial<ClientCard> = {}): ClientCard {
  return {
    telegram_id: 1,
    intent: 'booking',
    lead_status: 'estimated',
    category: 'large',
    idea: 'полурукав, чёрный блэкворк',
    size: 'half_sleeve',
    placement: 'рука',
    first_tattoo: 'yes',
    existing_tattoo: 'no',
    direct_tattoo_allowed: 'no',
    consultation_needed: 'yes',
    active_work_time_estimate: 'unknown',
    price_quoted: '2800',
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

interface Case {
  name: string;
  card: ClientCard;
  nextStep: NextStep;
  lastClientMessage: string;
  recentHistory?: RecentDialogTurn[];
  check: (reply: string) => { ok: boolean; label: string };
}

const expectPerSession = (reply: string) => {
  const ok = /сеанс|встреч/i.test(reply);
  return { ok, label: `упоминание "за сеанс"/"за встречу": ${ok ? 'есть' : 'НЕТ'}` };
};

const expectNoBigTotal = (reply: string) => {
  // Для крупного проекта без настойчивой просьбы — не должно быть числа,
  // заметно большего price_quoted (грубая эвристика: ищем суммы >6000).
  const bigNumberMatch = reply.match(/\b([6-9]\d{3}|\d{5,})\s*₪/);
  const ok = !bigNumberMatch;
  return {
    ok,
    label: ok
      ? 'не называет итог >6000₪, как и задумано'
      : `FAIL — упомянута крупная сумма (${bigNumberMatch?.[0]}) без настойчивой просьбы клиента`,
  };
};

const expectRangeMentioned = (reply: string) => {
  const ok = /–|-|\bот\b.*\bдо\b/.test(reply) && /₪/.test(reply);
  return { ok, label: ok ? 'упомянут диапазон суммы' : 'FAIL — диапазон суммы не найден' };
};

const expectNoExactSessionPromise = (reply: string) => {
  // Не должно быть вида "будет 6 сеансов" (точное число без "ориентир"/
  // "примерно"/"обычно"/"зависит").
  const hasExactClaim = /\bбудет\s+\d+\s+сеанс/i.test(reply);
  return {
    ok: !hasExactClaim,
    label: hasExactClaim
      ? 'FAIL — похоже на точное обещание числа сеансов'
      : 'не обещает точное число сеансов',
  };
};

const BOOKING_CTA = /записат|запис[ыь]|бронир|пока думаешь|присматриваешься/i;

const expectNoBookingCta = (reply: string) => {
  const hit = reply.match(BOOKING_CTA);
  return {
    ok: !hit,
    label: hit ? `FAIL — снова вопрос про запись ("${hit[0]}")` : 'ответ без вопроса про запись',
  };
};

const all =
  (...checks: ((r: string) => { ok: boolean; label: string })[]) =>
  (reply: string) => {
    const results = checks.map((c) => c(reply));
    return { ok: results.every((r) => r.ok), label: results.map((r) => r.label).join('; ') };
  };

const mentions = (re: RegExp, what: string) => (reply: string) => {
  const ok = re.test(reply);
  return { ok, label: ok ? `есть: ${what}` : `FAIL — нет: ${what}` };
};

// Реальный диалог из прода (28.10.2026): после цены клиент три раза
// возражает, бот трижды повторяет "хочешь записаться?".
const objectionCard = baseCard({
  category: 'project',
  idea: 'рукав, воздушная абстракция с просветами',
  size: 'full_sleeve',
  price_quoted: '2800',
  price_shown: 'yes',
  price_factors:
    'много негативного пространства и тонкой авторской проработки; большая зона — вся рука || project, 4-6 сеансов',
});
const objectionHistory: RecentDialogTurn[] = [
  { from: 'client', text: 'сколько будет стоить?' },
  { from: 'inka', text: 'по такому объёму ориентир 2800₪ за сеанс. точнее мастер скажет после консультации.' },
  { from: 'client', text: 'ок' },
  { from: 'inka', text: 'хочешь записаться на консультацию, или пока думаешь?' },
];

const cases: Case[] = [
  {
    name: '5 — "почему так дорого" сразу после вопроса про запись: ответ без CTA',
    card: objectionCard,
    nextStep: 'price_followup_chat',
    lastClientMessage: 'почему так дорого?',
    recentHistory: objectionHistory,
    check: all(expectNoBookingCta, expectPerSession),
  },
  {
    name: '6 — "но работа же не плотная": признать наблюдение и назвать, что держит цену',
    card: objectionCard,
    nextStep: 'price_followup_chat',
    lastClientMessage: 'но работа же не плотная, там много пустого места',
    recentHistory: [
      ...objectionHistory,
      { from: 'client', text: 'почему так дорого?' },
      { from: 'inka', text: 'это цена за один сеанс, не за весь рукав — встреч будет несколько.' },
    ],
    check: all(expectNoBookingCta, mentions(/негатив|воздух|просвет|проработ|переход/i, 'реальная причина из price_reasons')),
  },
  {
    name: '7 — повторный вопрос про запись после двух ответов: другими словами, не шаблоном',
    card: objectionCard,
    nextStep: 'ask_wants_to_book',
    lastClientMessage: 'понятно, спасибо, теперь яснее',
    recentHistory: [
      ...objectionHistory,
      { from: 'client', text: 'почему так дорого?' },
      { from: 'inka', text: 'это цена за один сеанс, не за весь рукав — встреч будет несколько.' },
      { from: 'client', text: 'но работа же не плотная' },
      { from: 'inka', text: 'да, заливки немного — цену держит тонкая проработка просветов, это дольше.' },
    ],
    check: (reply) => {
      const asks = /запис|консультац|бронир/i.test(reply);
      const sameAsBefore = reply.toLowerCase().includes('хочешь записаться на консультацию, или пока думаешь');
      return {
        ok: asks && !sameAsBefore,
        label: !asks ? 'FAIL — не вернулась к записи' : sameAsBefore ? 'FAIL — дословный повтор CTA' : 'вернулась к записи другими словами',
      };
    },
  },
  {
    name: '8 — "можно посмотреть работы мастера?": не выдумывает ссылки и не говорит про Аню',
    card: objectionCard,
    nextStep: 'price_followup_chat',
    lastClientMessage: 'а можно где-то посмотреть работы мастера? он вообще кто?',
    recentHistory: objectionHistory,
    check: (reply) => {
      const leak = /ink_anya|inkanya|инстаграм\.com|instagram\.com|http|Аня|\bона\b/i.exec(reply);
      return { ok: !leak, label: leak ? `FAIL — утечка/выдуманная ссылка ("${leak[0]}")` : 'без чужих и выдуманных ссылок' };
    },
  },
  {
    name: '1 — небольшой для Платона проект (large), прогноз ≤6000₪: можно дать диапазон',
    card: baseCard({
      category: 'large',
      idea: 'полурукав, чёрный блэкворк без декора',
      price_quoted: '2500',
      price_factors: 'плотная заливка чёрным без декора || large, 2-4 сеанса по внутренней оценке',
    }),
    nextStep: 'quote_price',
    lastClientMessage: 'а сколько это всё вместе будет стоить примерно?',
    check: expectRangeMentioned,
  },
  {
    name: '2 — крупный проект (project), прогноз выше 6000₪: НЕ озвучивать итог без запроса',
    card: baseCard({
      category: 'project',
      idea: 'полный рукав, воздушная абстракция',
      size: 'full_sleeve',
      price_quoted: '3300',
      price_factors: 'воздушная абстракция с негативным пространством; вся рука целиком || project, ориентир 4-6 сеансов',
    }),
    nextStep: 'quote_price',
    lastClientMessage: 'а сколько это будет стоить?',
    check: expectPerSession,
  },
  {
    name: '2б — тот же крупный проект: клиент НЕ настаивал, итог не должен звучать',
    card: baseCard({
      category: 'project',
      idea: 'полный рукав, воздушная абстракция',
      size: 'full_sleeve',
      price_quoted: '3300',
      price_factors: 'воздушная абстракция с негативным пространством; вся рука целиком || project, ориентир 4-6 сеансов',
    }),
    nextStep: 'quote_price',
    lastClientMessage: 'а сколько это будет стоить?',
    check: expectNoBigTotal,
  },
  {
    name: '3 — крупный проект, клиент НАСТОЙЧИВО просит итог (дважды) — честный широкий диапазон',
    card: baseCard({
      category: 'project',
      idea: 'полный рукав, воздушная абстракция',
      size: 'full_sleeve',
      price_quoted: '3300',
      price_factors: 'воздушная абстракция с негативным пространством; вся рука целиком || project, ориентир 4-6 сеансов',
    }),
    nextStep: 'quote_price',
    lastClientMessage:
      'нет, я понимаю что за сеанс, но мне правда важно понимать порядок цифр на весь проект целиком, назови хоть примерно диапазон',
    recentHistory: [
      { from: 'client', text: 'а сколько весь рукав целиком будет стоить в итоге?' },
      {
        from: 'inka',
        text: 'за сеанс примерно 3300₪, а по итогу зависит от числа сеансов — скажу точнее по ходу работы',
      },
    ],
    check: expectRangeMentioned,
  },
  {
    name: '4 — референс "точь-в-точь": не обещать точную сумму/число сеансов по фото',
    card: baseCard({
      category: 'project',
      idea: 'рукав по референсу',
      price_quoted: '3000',
    }),
    nextStep: 'quote_price',
    lastClientMessage: 'хочу вот точь-в-точь как на фото, сколько это будет стоить и сколько сеансов?',
    check: expectNoExactSessionPromise,
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
  console.log('DIALOG EVAL — ПЛАТОН, раскрытие суммы и референс');
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
    console.log('ИТОГО: есть проблемы — см. FAIL/ОШИБКА выше (это ручной eval, не CI-гейт).');
    process.exit(1);
  }
  console.log('ИТОГО: все сценарии прошли проверку.');
}

main();
