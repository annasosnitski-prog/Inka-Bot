// ============================================================
// INKA-BOT — Voice eval: Коммерсант, архетипы, манера разговора, итог
// НЕ часть `npm test` и не CI-гейт на каждый push: живые вызовы OpenAI
// (Responder + судья). Диалоги идут по-настоящему последовательно: каждый
// ответ Инки попадает в историю следующего хода. Шаг на ход задан тем,
// что вернул бы getNextStep (маршрутизация проверяется в npm test).
//
// Сценарии A–G из ТЗ 28.10.2026. Проверка двухслойная: жёсткие правила
// кодом (CTA, суммы, ссылки) + судья-модель по качеству общения.
//
// Запуск: OPENAI_API_KEY=... npm run eval:voice
// (прогоняет MASTER_PROFILE=platon, затем anya — профиль читается при
// загрузке промпта, поэтому по процессу на мастера)
// ============================================================

import { runResponder } from '../lib/responder';
import { callOpenAIChat } from '../lib/openai';
import { getMasterProfile } from '../lib/masters';
import type { ClientCard, NextStep } from '../lib/stateMachine';
import type { RecentDialogTurn } from '../lib/dialogLog';

const PROFILE = getMasterProfile().id;

function card(over: Partial<ClientCard> = {}): ClientCard {
  return {
    telegram_id: 1, intent: 'booking', lead_status: 'estimated', category: 'project',
    idea: 'рукав, абстракция на чёрной базе', size: 'full_sleeve', placement: 'рука',
    first_tattoo: 'no', existing_tattoo: 'no', direct_tattoo_allowed: 'no', consultation_needed: 'yes',
    active_work_time_estimate: 'unknown', price_quoted: '3000', price_explained: 'yes', price_factors: null,
    price_shown: 'yes', wants_to_book: null, phone: null, decline_followup_asked: null, client_name: 'Тест',
    contact_channel: 'telegram', social_link: null, social_asked: 'yes', reference_asked: 'yes',
    payment_status: null, client_type: '2_reference', skin_notes: null, spam_count: 0, chosen_slot_id: null,
    slot_options: [], booked_slot_display: null, booked_slot_start_iso: null, payment_reminder_sent: null,
    photos_count: 1, has_photo_this_message: false, photo_has_caption: false, force_client_mode: null,
    booked_at: null, payment_reminder_early_sent: null, service_fit: null, second_project_flagged: null,
    campaign_id: null, campaign_collected: null, campaign_handoff_sent: null, campaign_last_id: null,
    campaign_return_pending: null,
    ...over,
  };
}

type Check = (reply: string) => string | null; // null = ok, иначе причина FAIL
interface Turn { client: string; step: NextStep; checks?: Check[] }
interface Scenario {
  name: string;
  profile: 'anya' | 'platon';
  card: ClientCard;
  history?: RecentDialogTurn[];
  turns: Turn[];
  // Критерии судьи по всему диалогу; пусто — только проверки кодом.
  judge?: string;
}

const BOOKING_CTA = /записат|запис[ыь]|бронир|пока думаешь|присматриваешься/i;
const noCta: Check = (r) => (BOOKING_CTA.test(r) ? `CTA про запись ("${r.match(BOOKING_CTA)![0]}")` : null);
const noSum = (over: number): Check => (r) => {
  const nums = Array.from(r.matchAll(/(\d[\d\s]{2,})\s*₪/g)).map((m) => Number(m[1].replace(/\s/g, '')));
  const big = nums.find((n) => n > over);
  return big ? `названа сумма ${big}₪ > ${over}₪` : null;
};
const hasSumAtLeast = (min: number): Check => (r) => {
  const nums = Array.from(r.matchAll(/(\d[\d\s]{2,})\s*₪/g)).map((m) => Number(m[1].replace(/\s/g, '')));
  return nums.some((n) => n >= min) ? null : `нет суммы ≥ ${min}₪`;
};
const has = (re: RegExp, what: string): Check => (r) => (re.test(r) ? null : `нет: ${what}`);
const hasNot = (re: RegExp, what: string): Check => (r) => (re.test(r) ? `есть: ${what}` : null);
const noCapAsMax: Check = (r) =>
  /(максимум|не больше|не дороже|до)\s*6\s?000/i.test(r) ? 'порог 6000₪ подан как максимум' : null;

// Как в реальном диалоге 28.10: работа воздушная, клиент замечает, что
// чёрного мало, — а у Платона именно это и держит цену сеанса.
const objectionSleeve = card({
  price_quoted: '3000',
  price_factors:
    'абстракция с высокой детализацией и негативным пространством; вся рука целиком || project, 4-10 сеансов, итог ≈ 12000–30000₪',
});

const bigSleeve = card({
  price_quoted: '3000',
  price_factors:
    'плотная заливка с абстракцией и высокой детализацией; вся рука целиком || project, 4-10 сеансов, итог ≈ 12000–30000₪',
});

const ALL: Scenario[] = [
  {
    name: 'A — цена и возражение: три хода, каждый новый, без CTA',
    profile: 'platon',
    card: objectionSleeve,
    history: [
      { from: 'client', text: 'сколько будет стоить рукав?' },
      { from: 'inka', text: 'по такому объёму ориентир 3000₪ за сеанс. точнее мастер скажет после консультации.' },
    ],
    turns: [
      { client: 'почему 3000?', step: 'price_followup_chat', checks: [noCta] },
      { client: 'а от чего зависит?', step: 'price_followup_chat', checks: [noCta] },
      { client: 'так там же мало чёрного', step: 'price_followup_chat', checks: [noCta] },
    ],
    judge: `1) Каждый ответ Инки даёт НОВУЮ содержательную информацию, а не пересказ прошлого ответа. Уже названная причина может прозвучать снова, только если она нужна для ответа на новое наблюдение и подана с новой стороны.
2) Ни один ответ не заканчивается предложением записи. "Мастер уточнит на консультации" не должно повторяться хвостом в каждом ответе.
3) На "так там же мало чёрного" Инка признаёт верное наблюдение (если оно верно) и называет, что на самом деле держит цену.
4) Аргументы не повторяются из хода в ход. Ценность объясняется через работу, без "качество"/"того стоит".`,
  },
  {
    name: 'B — один вопрос, пять манер клиента',
    profile: 'platon',
    card: bigSleeve,
    turns: [
      { client: 'фрихенд входит?', step: 'price_followup_chat', checks: [noCta] },
      { client: 'Добрый день. Хотела уточнить: если мастер рисует прямо на теле, это входит в стоимость сеанса или считается отдельно? Просто хочу заранее понимать.', step: 'price_followup_chat', checks: [noCta] },
      { client: 'а фрихенд у вас входит или за него ещё почку попросите? 😄', step: 'price_followup_chat', checks: [noCta] },
      { client: 'слушайте, мне уже третий раз непонятно отвечают. фрихенд входит в цену или нет??', step: 'price_followup_chat', checks: [noCta] },
      { client: 'ооо, а мастер рисует прямо по телу? это же так круто, линии сразу ложатся по мышцам! это входит?', step: 'price_followup_chat', checks: [noCta] },
    ],
    judge: `Это НЕ один диалог: пять разных клиентов задают один и тот же вопрос в разной манере (сухо, подробно-вежливо, с иронией, с раздражением, с художественным восторгом). Оцени:
1) Ответы заметно различаются по манере и подстраиваются под клиента (сухому — коротко; ироничному — можно с лёгкой иронией; раздражённому — прямо и спокойно, без оправданий; восторженному — живо, но без театра).
2) Фактическое содержание одно и то же во всех пяти: ни один ответ не противоречит другим и ничего не выдумывает (например, отдельную цену за фрихенд). Справка: цена этой работы 3000₪ за сеанс — упомянуть её можно.
3) Ни в одном нет названий архетипов и демонстрации приёмов.`,
  },
  {
    name: 'C — преемственность тона: спокойно → идея → цена → шутка → практика',
    profile: 'platon',
    card: card({ price_shown: 'yes', price_quoted: '3300',
      price_factors: 'воздушная абстракция с негативным пространством; вся рука || project, 4-6 сеансов, итог ≈ 13200–19800₪' }),
    history: [
      { from: 'client', text: 'здравствуйте. интересует рукав, абстракция.' },
      { from: 'inka', text: 'привет. по такой абстракции на всю руку ориентир 3300₪ за сеанс. точнее мастер скажет после консультации.' },
    ],
    turns: [
      { client: 'понятно. спасибо.', step: 'ask_wants_to_book' },
      { client: 'пока не решила. хочу, чтобы там было много пустой кожи, как будто дым идёт по руке', step: 'price_followup_chat', checks: [noCta] },
      { client: 'а сеанс сколько по времени и цена та же?', step: 'price_followup_chat', checks: [noCta] },
      { client: 'ну если дым, то может мне ещё и бросить курить заодно 😅', step: 'price_followup_chat' },
      { client: 'ладно. а консультация как проходит?', step: 'price_followup_chat' },
    ],
    judge: `1) Через весь диалог Инка звучит как ОДИН узнаваемый собеседник: уровень формальности, длина реплик и степень эмоций плавно следуют за клиентом, без резких скачков.
2) На художественную идею ("дым") Инка проявляет интерес, но не превращается внезапно в восторженного художественного критика (одна короткая мастерская мысль о форме — норма).
5) Инка не выдумывает фактов, которых не могла знать (длительность сеанса в часах, точное число встреч). Справка, которую Инке дали: консультация бесплатная, в переписке, около 20 минут; цена 3300₪ за сеанс.
3) На шутку может мягко подхватить, без язвительности и без шуток над привычками/телом клиента.
4) Нет фраз, объясняющих смену тона. Нет названий архетипов.`,
  },
  {
    name: 'D1 — интерес без готовности: поддержать, а не повторять консультацию',
    profile: 'platon',
    card: bigSleeve,
    turns: [
      { client: 'мне очень нравится такой подход, но я пока не готова записываться, просто присматриваюсь', step: 'all_done' },
    ],
    judge: `1) Инка спокойно принимает, что клиент пока не готов, без давления и уговоров.
2) Поддерживает интерес содержательно (реакция на подход/идею или ненавязчивый следующий шаг), а не сводит всё к "записаться на консультацию".
3) Не выясняет автоматически, что клиента останавливает.`,
  },
  {
    name: 'D2 — "как начать такой проект?": объяснить процесс и предложить шаг',
    profile: 'platon',
    card: bigSleeve,
    turns: [
      { client: 'мне нравится этот подход. а как вообще начать такой проект?', step: 'price_followup_chat',
        checks: [has(/консультац|эскиз|встреч|начн|первы/i, 'процесс/следующий шаг')] },
    ],
    judge: `1) Инка объясняет, как начинается такой проект (по шагам, коротко).
2) Предлагает конкретный следующий шаг, потому что клиент сам спросил, как начать.`,
  },
  {
    name: 'E — отказ: не преодолевать',
    profile: 'platon',
    card: bigSleeve,
    turns: [
      { client: 'нет, спасибо, я не хочу продолжать', step: 'all_done',
        checks: [hasNot(/останавлива|почему|что не так|может всё-таки|может все-таки/i, 'попытка преодолеть отказ')] },
    ],
    judge: `1) Инка принимает отказ по-человечески и коротко.
2) Не уговаривает, не спрашивает, что останавливает, не предлагает услугу заново. Одна фраза "если что — пиши" допустима.`,
  },
  {
    name: 'F1 — Платон: первый вопрос об итоге большого проекта',
    profile: 'platon',
    card: bigSleeve,
    turns: [
      { client: 'а сколько весь рукав будет стоить в итоге?', step: 'price_followup_chat',
        checks: [noSum(6000), has(/сеанс|встреч/i, 'цена за сеанс/встречу'), noCta] },
    ],
    judge: `1) Инка не уходит от вопроса: называет цену сеанса и объясняет, из чего складывается общая сумма и что в ней пока неизвестно.
2) Не называет огромную итоговую цифру и не выдумывает точное число сеансов.
3) Не прикрывается консультацией вместо ответа.`,
  },
  {
    name: 'F2 — Платон: настойчивый повтор → честный широкий диапазон, 6000 не потолок',
    profile: 'platon',
    card: bigSleeve,
    history: [
      { from: 'client', text: 'а сколько весь рукав будет стоить в итоге?' },
      { from: 'inka', text: 'за сеанс ориентир 3000₪. итог зависит от того, сколько встреч займёт рукав — это станет понятно по эскизу и плотности.' },
    ],
    turns: [
      { client: 'я понимаю, но мне правда нужен порядок цифр на весь рукав, хотя бы примерно', step: 'price_followup_chat',
        checks: [hasSumAtLeast(12000), noCapAsMax, hasNot(/будет\s+\d+\s+сеанс/i, 'точное число сеансов')] },
    ],
  },
  {
    name: 'F3 — Платон: прикидка ≤6000₪ — можно назвать без нажима',
    profile: 'platon',
    card: card({ category: 'large', size: 'half_sleeve', idea: 'полурукав, плотная заливка', price_quoted: '2500',
      price_factors: 'плотная заливка чёрным без декора || large, 2 сеанса, итог ≈ 5000–6000₪' }),
    turns: [
      { client: 'а примерно сколько всего получится?', step: 'price_followup_chat',
        checks: [has(/5\s?000|6\s?000/, 'диапазон итога'), noSum(6000)] },
    ],
  },
  {
    name: 'F4 — Платон: данных об итоге нет — не выдумывать',
    profile: 'platon',
    card: card({ price_quoted: '3200', price_factors: 'графика средней детализации || project, итог: нет данных' }),
    turns: [
      { client: 'сколько всего будет стоить?', step: 'price_followup_chat', checks: [noSum(3200)] },
    ],
  },
  {
    name: 'G1 — Платон: ценность из его профиля',
    profile: 'platon',
    card: bigSleeve,
    turns: [
      { client: 'а что вообще входит в работу мастера? за что я плачу?', step: 'price_followup_chat',
        checks: [hasNot(/Аня|Ани\b|ink_anya|inkanya/i, 'данные Ани'), noCta] },
    ],
    judge: `1) Инка говорит о конкретных особенностях работы мастера (авторская композиция, фрихенд, работа с зоной целиком, негативное пространство и т.п.), а не общими словами "качество", "индивидуальный подход".
2) Не перечисляет всё подряд как рекламу; выбирает то, что относится к этой работе (рукав, абстракция на чёрной базе).
3) О мастере говорит в мужском роде или нейтрально.`,
  },
  {
    name: 'G2 — Аня: ссылки и род свои, итог многосеансовой работы не выдумывает',
    profile: 'anya',
    card: card({ category: 'project', idea: 'спина, графика', size: 'full_back', price_quoted: '2400',
      price_factors: 'большая зона — вся спина; авторская композиция || project, итог: нет данных' }),
    turns: [
      { client: 'а где посмотреть работы мастера?', step: 'price_followup_chat',
        checks: [has(/ink_anya|inkanya/i, 'портфолио Ани'), hasNot(/Платон/i, 'Платон')] },
      { client: 'и сколько всего выйдет спина?', step: 'price_followup_chat', checks: [noSum(2400)] },
    ],
  },
  {
    name: 'G3 — Аня: прикидка ≤2500₪ — можно назвать',
    profile: 'anya',
    card: card({ category: 'large', idea: 'бедро, графика', size: 'large', price_quoted: '1200',
      price_factors: 'большая графика без плотной заливки || large, 2 встречи, итог ≈ 2000–2400₪' }),
    turns: [
      { client: 'а всего сколько примерно получится?', step: 'price_followup_chat',
        checks: [has(/2\s?000|2\s?400/, 'диапазон итога'), noSum(2500), hasNot(/6\s?000/, 'порог Платона')] },
    ],
  },
];

async function judge(s: Scenario, transcript: string): Promise<string | null> {
  if (!s.judge) return null;
  const out = await callOpenAIChat({
    model: 'gpt-5.4',
    temperature: 0,
    responseFormatJson: true,
    label: 'Judge',
    messages: [
      {
        role: 'system',
        content:
          'Ты строгий редактор живой переписки тату-ассистентки Инки с клиентом. Оцени по критериям. ' +
          'Верни JSON {"pass": boolean, "failed": [номера невыполненных критериев], "reason": "одно-два предложения"}. ' +
          'pass=true только если выполнены ВСЕ критерии. Строки с пометкой [контекст] — заданное начало разговора: ' +
          'их не оценивай, оценивай только реплики Инки после них.',
      },
      { role: 'user', content: `КРИТЕРИИ:\n${s.judge}\n\nПЕРЕПИСКА:\n${transcript}` },
    ],
  });
  const v = JSON.parse(out) as { pass: boolean; failed?: number[]; reason?: string };
  return v.pass ? null : `судья: критерии ${JSON.stringify(v.failed ?? [])} — ${v.reason ?? ''}`;
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY не задан — живой eval невозможен. Это НЕ пройдено.');
    process.exit(1);
  }
  const only = process.env.ONLY; const scenarios = ALL.filter((s) => s.profile === PROFILE && (!only || s.name.startsWith(only)));
  console.log(`\n=== VOICE EVAL — профиль ${PROFILE}, сценариев: ${scenarios.length} ===\n`);
  let failed = 0;
  for (const s of scenarios) {
    console.log(`▶ ${s.name}`);
    const problems: string[] = [];
    // B — пять независимых клиентов, остальные — один диалог.
    const independent = s.name.startsWith('B ');
    let history: RecentDialogTurn[] = [...(s.history ?? [])];
    // Заданное начало разговора — контекст, судья его не оценивает.
    const lines: string[] = history.map((t) => `[контекст] ${t.from === 'client' ? 'Клиент' : 'Инка'}: ${t.text}`);
    try {
      for (let i = 0; i < s.turns.length; i++) {
        const t = s.turns[i];
        if (independent) history = [...(s.history ?? [])];
        const reply = await runResponder({
          nextStep: t.step,
          clientCard: s.card,
          lastClientMessage: t.client,
          recentHistory: history,
          slotsDisplay: null,
        });
        console.log(`  клиент: ${t.client}\n  Инка:   ${reply}`);
        lines.push(`${independent ? `[клиент ${i + 1}] ` : ''}Клиент: ${t.client}`, `Инка: ${reply}`);
        for (const c of t.checks ?? []) {
          const p = c(reply);
          if (p) problems.push(`ход ${i + 1}: ${p}`);
        }
        history.push({ from: 'client', text: t.client }, { from: 'inka', text: reply });
      }
      const j = await judge(s, lines.join('\n'));
      if (j) problems.push(j);
    } catch (err) {
      problems.push(`ОШИБКА ВЫЗОВА: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (problems.length) {
      failed++;
      for (const p of problems) console.log(`  FAIL — ${p}`);
    } else {
      console.log('  PASS');
    }
    console.log('');
  }
  console.log(`ИТОГО (${PROFILE}): ${scenarios.length - failed} прошли, ${failed} не прошли.`);
  if (failed) process.exit(1);
}

main();
