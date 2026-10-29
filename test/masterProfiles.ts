// Профили мастеров: выбор по env, изоляция (бот одного мастера не говорит
// чужими ценами/ссылками/родом), сборка промптов без оставшихся {{...}},
// разделение price_factors на "для клиента" и "внутреннее".
import { getMasterProfile } from '../lib/masters';
import { anya } from '../lib/masters/anya';
import { platon } from '../lib/masters/platon';
import { buildExtractorPrompt, normalizeExtractorOutput, type ExtractorOutput } from '../lib/extractor';
import { buildResponderPrompt, clientPriceReasons, projectTotalEstimate } from '../lib/responder';
import { buildAdminPrompt } from '../lib/admin';
import { getCampaign } from '../lib/campaigns';
import { resolveMasterTelegramId } from '../lib/masterTelegramId';
import { tagDisplayLabel, tagsForRequest, busyMarkerForTag } from '../lib/calendar';
import { parseAddSlotCommand } from '../lib/addSlotParser';
import { inkaRepliesSinceStep, lastInkaStep, type DialogEntry } from '../lib/dialogLog';

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

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

console.log('\n▶ выбор профиля');
withEnv({ MASTER_PROFILE: undefined, PRICING_PROFILE: undefined }, () => {
  ok('без env → Аня', getMasterProfile().id === 'anya');
});
withEnv({ MASTER_PROFILE: 'platon', PRICING_PROFILE: undefined }, () => {
  ok('MASTER_PROFILE=platon → Платон', getMasterProfile().id === 'platon');
});
withEnv({ MASTER_PROFILE: undefined, PRICING_PROFILE: 'platon' }, () => {
  ok('старое PRICING_PROFILE=platon тоже работает', getMasterProfile().id === 'platon');
});
withEnv({ MASTER_PROFILE: 'nobody', PRICING_PROFILE: undefined }, () => {
  let threw = false;
  try {
    getMasterProfile();
  } catch {
    threw = true;
  }
  ok('неизвестный профиль → ошибка, а не тихий откат на Аню', threw);
});

console.log('\n▶ сборка промптов');
const ANYA_MARKERS = ['ink_anya', 'inkanya', 'INKANYA', 'Аня', 'Ани ', 'Ане ', 'Аней'];
const PLATON_MARKERS = ['Платон'];
const GENDER_LEAKS = ['мастер — женщина', 'мастер должна', 'мастер написала', 'мастер могла', 'мастер сама'];

for (const [label, build] of [
  ['extractor', buildExtractorPrompt],
  ['responder', buildResponderPrompt],
  ['admin', buildAdminPrompt],
] as const) {
  const forPlaton = build(platon);
  const forAnya = build(anya);
  const leftover = (t: string) => t.match(/\{\{[A-Z_]+\}\}/g) ?? [];
  ok(`${label}: у Платона не осталось {{...}}`, leftover(forPlaton).length === 0, leftover(forPlaton).join(','));
  ok(`${label}: у Ани не осталось {{...}}`, leftover(forAnya).length === 0, leftover(forAnya).join(','));
  const anyaInPlaton = ANYA_MARKERS.filter((m) => forPlaton.includes(m));
  ok(`${label}: в промпте Платона нет Ани и её ссылок`, anyaInPlaton.length === 0, anyaInPlaton.join(','));
  const platonInAnya = PLATON_MARKERS.filter((m) => forAnya.includes(m));
  ok(`${label}: в промпте Ани нет Платона`, platonInAnya.length === 0, platonInAnya.join(','));
  const genderInPlaton = GENDER_LEAKS.filter((m) => forPlaton.includes(m));
  ok(`${label}: у Платона нет женского рода мастера`, genderInPlaton.length === 0, genderInPlaton.join(','));
}

{
  const r = buildResponderPrompt(platon);
  ok('responder Платона: депозит 400', r.includes('400₪') && !r.includes('200₪'));
  ok('responder Платона: его Instagram, без ссылок Ани', r.includes('instagram.com/platon_tattoo__') && !r.includes('ink_anya') && !r.includes('inkanya'));
  ok('responder: вопрос «что ещё обдумать» обязателен при «подумаю»', r.includes('ОБЯЗАТЕЛЬНО') && r.includes('что ещё нужно обдумать'));
  ok('responder Платона: порог раскрытия итога 6000₪', r.includes('порог — 6000₪') && !r.includes('2500₪'));
  ok('responder Платона: реализм не в списке отказов', /Реализм сам по себе/.test(r));
  const a = buildResponderPrompt(anya);
  ok('responder Ани: её портфолио на месте', a.includes('https://www.instagram.com/ink_anya'));
  ok('responder Ани: депозит 200', a.includes('200₪'));
  ok('responder Ани: порог раскрытия итога 2500₪, без 6000₪', a.includes('порог — 2500₪') && !a.includes('6000₪'));
  ok('политика итога одна, в ядре: у обоих одинаковый текст правила',
    a.replace(/2500/g, 'N') .includes('ИТОГОВАЯ СУММА ПРОЕКТА (общее правило') &&
    r.includes('ИТОГОВАЯ СУММА ПРОЕКТА (общее правило') &&
    (a.match(/ИТОГОВАЯ СУММА ПРОЕКТА/g) ?? []).length === 1 &&
    (r.match(/ИТОГОВАЯ СУММА ПРОЕКТА/g) ?? []).length === 1);
  ok('порог прямо назван не потолком цены', a.includes('НЕ потолок') && r.includes('НЕ потолок'));
  const tail = (t: string) => t.slice(t.indexOf('ИТОГОВАЯ СУММА ПРОЕКТА'), t.indexOf('СОСТОЯНИЯ КЛИЕНТА ПОСЛЕ ЦЕНЫ'));
  ok('текст правила итога у мастеров отличается только числом',
    tail(a).replace(/2500/g, 'N') === tail(r).replace(/6000/g, 'N'));
  ok('фиксированной триады больше нет', !/ПРОДАВЕЦ|Продавец|БАЗОВАЯ ТРИАДА/.test(a));
  const seven = ['ТРИКСТЕР', 'ЖЕНЩИНА / ТЕПЛО', 'ИССЛЕДОВАТЕЛЬ', 'МУДРЕЦ', 'ДУРАК', 'LOVER', 'ТВОРЕЦ'];
  ok('все 7 архетипов на месте', seven.every((x) => a.includes(x)), seven.filter((x) => !a.includes(x)).join(','));
  ok('старых ситуативных архетипов нет', !/ЗАБОТЛИВЫЙ|БУНТАРЬ|ПРАВИТЕЛЬ/.test(a));
  ok('есть контроль теней и манера разговора', a.includes('КОНТРОЛЬ ТЕНЕЙ') && a.includes('МАНЕРА ЭТОГО РАЗГОВОРА'));
  ok('ценность Платона — только у Платона', r.includes('Негативное пространство: незакрашенная') && !a.includes('Негативное пространство: незакрашенная'));
  ok('ценность Ани — только у Ани', a.includes('Посадка по телу') && !r.includes('Посадка по телу'));
  ok('у Ани нет особых правил — подставлена заглушка', a.includes('Особых правил нет'));
  ok('правило референса Платона только у Платона', r.includes('делает свою версию, а не копию') && !a.includes('делает свою версию, а не копию'));
  ok('responder: блок КОММЕРСАНТ есть у обоих', a.includes('КОММЕРСАНТ') && r.includes('КОММЕРСАНТ'));
  ok('responder: есть шаг price_followup_chat', a.includes('price_followup_chat'));
  const e = buildExtractorPrompt(platon);
  ok('extractor Платона: его шкала цен', e.includes('3700₪') && !e.includes('350–600₪'));
  ok('extractor Ани: её матрица', buildExtractorPrompt(anya).includes('350–600₪'));
}

console.log('\n▶ один мастер: бот не отправляет к другим');
for (const [label, build] of [
  ['extractor', buildExtractorPrompt],
  ['responder', buildResponderPrompt],
  ['admin', buildAdminPrompt],
] as const) {
  for (const [who, p, other] of [['Платон', platon, 'Аня'], ['Аня', anya, 'Платон']] as const) {
    const text = build(p);
    ok(`${label} ${who}: нет совета искать другого мастера`, !/(искать|найти|обратись|обратитесь)[^.\n]{0,30}друг(ого|ому|им)\s+мастер/i.test(text));
    ok(`${label} ${who}: нет имени «${other}»`, !text.includes(other));
  }
}
{
  const a = buildResponderPrompt(anya);
  const r = buildResponderPrompt(platon);
  ok('responder: правило «только этот мастер» у обоих', a.includes('ТОЛЬКО с этим одним мастером') && r.includes('ТОЛЬКО с этим одним мастером'));
  ok('responder: master_contact_requested у Платона говорит «он напишет», у Ани «она»',
    r.includes('Платон, он напишет') && a.includes('Аня, она напишет'));
  ok('responder: all_done без запрета на выяснение, есть undecided_followup_chat',
    a.includes('undecided_followup_chat') && !a.includes('барьер не выясняем') && !a.includes('Барьер не выясняем'));
  ok('responder: master_contact_requested задаёт вопрос про канал/номер, когда связи нет',
    a.includes('КАК МАСТЕР СВЯЖЕТСЯ') && a.includes('сюда в телеграм или в вотсап'));
  ok('responder: нет выдумывания скидок и способов связи', a.includes('скидок и особых') && a.includes('Способов связи'));
}

console.log('\n▶ кампании принадлежат профилю');
withEnv({ MASTER_PROFILE: undefined, PRICING_PROFILE: undefined }, () => {
  ok('у Ани color_texture активна', getCampaign('color_texture')?.id === 'color_texture');
});
withEnv({ MASTER_PROFILE: 'platon', PRICING_PROFILE: undefined }, () => {
  ok('у Платона чужая кампания не активируется', getCampaign('color_texture') === null);
});

console.log('\n▶ price_factors: клиенту только левая часть');
ok('левая часть отдаётся', clientPriceReasons('плотная заливка; рёбра || project, 6-12 сеансов') === 'плотная заливка; рёбра');
ok('старый формат без "||" — не показываем', clientPriceReasons('project ≈4800 суммарно') === null);
ok('null → null', clientPriceReasons(null) === null);

console.log('\n▶ project_total_estimate: только итог, без сеансов');
ok('диапазон итога', projectTotalEstimate('плотная заливка || project, рукав, 4–10 сеансов, итог ≈ 12000–30000₪') === '12000–30000₪');
ok('итог "от"', projectTotalEstimate('спина || project, от 10 сеансов, итог от 33000₪') === 'от 33000₪');
ok('нет данных → null', projectTotalEstimate('роза || medium, итог: нет данных') === null);
ok('старый формат → null', projectTotalEstimate('project ≈4800 суммарно') === null);
ok('слово "итог" в левой части не считается', projectTotalEstimate('итог ≈ 5000₪ || medium') === null);

console.log('\n▶ tattooBooking master принуждает консультацию в коде');
const raw = {
  idea: 'роза', size: '10 см', category: 'medium', direct_tattoo_allowed: 'yes', consultation_needed: 'no',
} as unknown as ExtractorOutput;
withEnv({ MASTER_PROFILE: 'platon', PRICING_PROFILE: undefined }, () => {
  const n = normalizeExtractorOutput(raw);
  ok('Платон: средняя работа всё равно на консультацию', n.direct_tattoo_allowed === 'no' && n.consultation_needed === 'yes');
});
withEnv({ MASTER_PROFILE: undefined, PRICING_PROFILE: undefined }, () => {
  const n = normalizeExtractorOutput(raw);
  ok('Аня: средняя работа может идти прямой записью', n.direct_tattoo_allowed === 'yes');
});

console.log('\n▶ inkaRepliesSinceStep');
const h = (steps: (string | undefined)[]): DialogEntry[] =>
  steps.flatMap((st) => [
    { from: 'client' as const, text: 'c', ts: '' },
    { from: 'inka' as const, text: 'i', ts: '', ...(st ? { step: st } : {}) },
  ]);
ok('шага нет → null', inkaRepliesSinceStep(h(['quote_price']), 'ask_wants_to_book') === null);
ok('последний ответ — этот шаг → 0', inkaRepliesSinceStep(h(['quote_price', 'ask_wants_to_book']), 'ask_wants_to_book') === 0);
ok(
  'два ответа после → 2',
  inkaRepliesSinceStep(h(['ask_wants_to_book', 'price_followup_chat', 'price_followup_chat']), 'ask_wants_to_book') === 2
);
ok('старые реплики без шага → null', inkaRepliesSinceStep(h([undefined, undefined]), 'ask_wants_to_book') === null);

ok('lastInkaStep: последний ответ Инки', lastInkaStep(h(['ask_wants_to_book', 'price_followup_chat'])) === 'price_followup_chat');
ok('lastInkaStep: старая история → undefined', lastInkaStep(h([undefined])) === undefined);

// Telegram-id мастера: чужой запасной id только для Ани
ok('id из env', resolveMasterTelegramId('123456', 'platon') === 123456);
ok('Платон без id → null (не id Ани)', resolveMasterTelegramId(undefined, 'platon') === null);
ok('Платон с мусором → null', resolveMasterTelegramId('abc', 'platon') === null);
ok('Аня без id → запасной старого деплоя', resolveMasterTelegramId('', 'anya') === 457343487);

// Ответ про цену: нет общего правила "меньше заливки = больше проработки"
const core = buildResponderPrompt();
ok('нет общего вывода про заливку и проработку', !/меньше заливки\s*—\s*больше проработки/.test(core) && !/заливки мало, а значит больше/.test(core.replace(/Плохо:[^\n]*\n[^\n]*\n/g, '')));
ok('аргумент цены только из price_reasons', /ТОЛЬКО тем, что названо в\s+price_reasons/.test(core));

// Консультация: предоплата по профилю
withEnv({ MASTER_PROFILE: 'platon' }, () => {
  const t = buildResponderPrompt();
  ok('Платон: предупреждение о предоплате 400₪ после консультации', /понадобится предоплата 400₪/.test(t));
  ok('{{CONSULTATION_DEPOSIT_NOTE}} подставлен', !t.includes('{{'));
});
withEnv({ MASTER_PROFILE: 'anya' }, () => {
  const t = buildResponderPrompt();
  ok('Аня: называет предоплату 200₪ при консультации', /нужна предоплата 200₪/.test(t));
});

withEnv({ MASTER_PROFILE: 'platon' }, () => {
  ok('Платон: слот консультации [КОНС] → «(в студии)»', tagDisplayLabel('[КОНС]') === ' (в студии)');
  ok('Платон: бот предлагает только [КОНС]', JSON.stringify(tagsForRequest('consultation')) === JSON.stringify(['[КОНС]']));
  ok('Платон: «/добавить чат» и «конса» → [КОНС]', ['чат', 'конса'].every((w) => { const r = parseAddSlotCommand(`${w} завтра 10:00-10:30`, new Date('2026-07-13T09:00:00Z')); return r.ok && r.tag === '[КОНС]'; }));
});
withEnv({ MASTER_PROFILE: 'anya' }, () => {
  ok('Аня: слот консультации [ЧАТ] → «(по переписке)»', tagDisplayLabel('[ЧАТ]') === ' (по переписке)');
  ok('Аня: бот предлагает только [ЧАТ]', JSON.stringify(tagsForRequest('consultation')) === JSON.stringify(['[ЧАТ]']));
  ok('Аня: «чат» и «конса» → [ЧАТ]', ['чат', 'конса'].every((w) => { const r = parseAddSlotCommand(`${w} завтра 10:00-10:30`, new Date('2026-07-13T09:00:00Z')); return r.ok && r.tag === '[ЧАТ]'; }));
});
ok('бронь [КОНС] → КОНС ЗАПИСЬ', busyMarkerForTag('[КОНС]', 'consultation') === 'КОНС ЗАПИСЬ');

console.log(`\nMASTER PROFILES: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

