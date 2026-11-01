// Живая проверка специализации Платона (ТЗ «Полная специализация», п. 15):
// сценарии по service_fit. Ожидание сверяется автоматически.
// Запуск: MASTER_PROFILE=platon npm run eval:spec:platon (нужен OPENAI_API_KEY).
import { runExtractor } from '../lib/extractor';

type Exp = 'allowed' | 'not_offered' | 'needs_clarification' | 'not_not_offered';
const cases: [string, string, Exp][] = [
  ['1 маленькая чёрная татуировка', 'хочу небольшую чёрную татуировку 5 см на запястье', 'not_offered'],
  ['2 полурукав blackwork', 'хочу полурукав в блэкворке, абстракция и чёрные массивы', 'allowed'],
  ['3 крупная работа на предплечье', 'хочу большую чёрную абстракцию на всё предплечье', 'not_not_offered'],
  ['4 размер неизвестен', 'хочу чёрную абстракцию на руку', 'not_not_offered'],
  ['5 крупная сакральная геометрия', 'хочу огромную сакральную геометрию на всю спину', 'not_offered'],
  ['6 органический freehand', 'хочу на весь рукав органический freehand с негативным пространством', 'allowed'],
  ['7 плотный blackout', 'хочу блэкаут на всю ногу, плотная заливка', 'allowed'],
  ['8 круглые просветы в blackout', 'хочу блэкаут на полурукав с круглыми просветами', 'allowed'],
  ['9 крупные буквы в blackwork', 'хочу полурукав blackwork, внутри крупные буквы как графический элемент', 'allowed'],
  ['10 каллиграфия', 'хочу каллиграфическую надпись на предплечье, написанную от руки', 'not_offered'],
  ['11 ч/б пионы на чёрной основе', 'хочу рукав, реалистичные чёрно-серые пионы на чёрной основе', 'allowed'],
  ['12 портрет в чёрной композиции', 'хочу на плече женский портрет в чёрной графической композиции с абстракцией, большой проект', 'not_not_offered'],
  ['13 цветной реализм', 'хочу цветной реалистичный портрет на всю голень, яркие цвета', 'not_offered'],
  ['14 fine line', 'хочу тонкую fine line татуировку', 'not_offered'],
  ['15 мандала', 'хочу большую мандалу на спину', 'not_offered'],
  ['16 old school', 'хочу old school рукав', 'not_offered'],
  ['17 акварель', 'хочу цветную акварельную работу на рукав', 'not_offered'],
  ['18 чёрная абстракция + красный акцент', 'хочу рукав чёрная абстракция с небольшим красным акцентом', 'allowed'],
  ['19 чёрная абстракция + локальные цветные элементы', 'хочу чёрную абстракцию на полруки с парой локальных цветных элементов', 'allowed'],
  ['20 цвет и чёрный поровну', 'хочу абстракцию на рукав, где цвет и чёрный занимают примерно поровну', 'needs_clarification'],
  ['21 цветная абстракция без чёрной основы', 'хочу полностью цветную абстракцию на рукав без чёрного', 'not_offered'],
  ['22 неясное «цвет и блэк»', 'хочу что-то с цветом и блэком', 'not_not_offered'],
];
// Цена: сравниваем пары одинаковых проектов, отличающихся только зоной или
// старой татуировкой (ТЗ п. 15, сценарии 23-36). Числа берутся из
// price_quoted автоматически.
const num = (v: unknown): number | null => {
  const m = String(v ?? '').replace(/\s/g, '').match(/\d{4}/);
  return m ? Number(m[0]) : null;
};
async function price(text: string): Promise<number | null> {
  const r = await runExtractor({
    currentCard: {} as any, messageText: text, hasPhoto: false, photoCaption: null, isAdminSender: false,
    recentHistory: [], photoFileId: null, hoursSinceLastMessage: null,
  });
  return num(r.price_quoted);
}
const proj = (zone: string, extra = '') =>
  `Хочу полный рукав... нет, хочу большую работу на ${zone}: плотный чёрный блэкворк без декора, размер на всю зону. ${extra}Первая тату, кожа чистая.`;
async function priceChecks(): Promise<number> {
  let ok = 0;
  const check = (name: string, pass: boolean, detail: string) => {
    if (pass) ok++;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(54)} ${detail}`);
  };
  const base = await price(proj('бедре'));
  const ribs = await price(proj('рёбрах'));
  const belly = await price(proj('животе'));
  const both = await price(proj('рёбрах и животе'));
  const expRibs = base ? Math.min(base + 500, 4000) : null;
  check('28/30 рёбра = база + 500 (потолок 4000)', ribs !== null && ribs === expRibs, `база ${base}, рёбра ${ribs}, ожидалось ${expRibs}`);
  check('29/31 живот = база + 500 (потолок 4000)', belly !== null && belly === expRibs, `база ${base}, живот ${belly}, ожидалось ${expRibs}`);
  check('32 рёбра и живот вместе — одна надбавка', both !== null && both === expRibs, `вместе ${both}, ожидалось ${expRibs}`);
  const noOverlap = await price(proj('бедре'));
  const overlap = await price(proj('бедре', 'Нужно перекрыть старую татуировку, она тёмная и плотная. '));
  check('24/25 перекрытие не даёт наценки', noOverlap !== null && overlap !== null && overlap === noOverlap, `без ${noOverlap}, с перекрытием ${overlap}`);
  check('33 вне зон рёбер/живота — без надбавки', base !== null && base <= 3700, `база ${base}`);
  return ok;
}

(async () => {
  let ok = 0;
  for (const [name, text, exp] of cases) {
    const r = await runExtractor({
      currentCard: {} as any, messageText: text, hasPhoto: false, photoCaption: null, isAdminSender: false,
      recentHistory: [], photoFileId: null, hoursSinceLastMessage: null,
    });
    const got = r.service_fit;
    const pass = exp === 'not_not_offered' ? got !== 'not_offered' : got === exp;
    if (pass) ok++;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(48)} ожидалось ${exp}, получено ${got} (${r.service_fit_reason ?? ''})`);
  }
  console.log(`\nСПЕЦИАЛИЗАЦИЯ ПЛАТОНА (стиль): ${ok}/${cases.length}`);
  const priceOk = await priceChecks();
  console.log(`СПЕЦИАЛИЗАЦИЯ ПЛАТОНА (цена): ${priceOk}/5`);
  if (ok < cases.length || priceOk < 5) process.exit(1);
})();
