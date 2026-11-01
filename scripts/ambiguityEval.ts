// Живая проверка двоякого ответа клиента после цены (Extractor).
// Запуск: npm run eval:ambiguity (нужен OPENAI_API_KEY).
import { runExtractor } from '../lib/extractor';

const card: any = {
  idea: 'пион', placement: 'предплечье', size: '15 см', existing_tattoo: 'no', price_quoted: '2500',
  price_shown: 'yes', price_explained: 'yes', wants_to_book: null, phone: null, client_name: null,
};
const cta = [
  { from: 'client' as const, text: 'хочу пион на предплечье' },
  { from: 'inka' as const, text: 'по такой работе выходит около 2500₪. хочешь записаться, или пока думаешь?' },
];
const afterPrice = [
  { from: 'client' as const, text: 'хочу пион на предплечье' },
  { from: 'inka' as const, text: 'по такой работе выходит около 2500₪, цена зависит от проработки.' },
];
type Exp = { amb?: boolean; yes?: boolean; undecided?: boolean; question?: boolean };
const cases: [string, any[], string, Exp][] = [
  ['ок после вопроса про запись', cta, 'ок', { amb: true }],
  ['окей', cta, 'окей', { amb: true }],
  ['хорошо', cta, 'хорошо', { amb: true }],
  ['давайте попробуем', cta, 'давайте попробуем', { amb: true }],
  ['наверное да', cta, 'наверное да', { amb: true }],
  ['ок после цены (двоякость гасит код, не модель)', afterPrice, 'ок', { yes: false }],
  ['ясное да', cta, 'да, хочу записаться', { yes: true }],
  ['запишите', cta, 'запишите меня', { yes: true }],
  ['как записаться', afterPrice, 'а как записаться?', { yes: true }],
  ['какие есть даты', afterPrice, 'а какие есть даты?', { yes: true }],
  ['да, но дорого', cta, 'да, но дорого', { amb: false, yes: false, question: true }],
  ['подумаю', cta, 'подумаю', { undecided: true, amb: false }],
  ['подумаю, но когда можно прийти', cta, 'подумаю, но когда можно прийти?', { undecided: true, amb: false }],
  ['вопрос про цену', cta, 'а почему так дорого?', { question: true, amb: false }],
  ['нет', cta, 'нет, спасибо', { yes: false, amb: false }],
  ['спасибо после цены', afterPrice, 'спасибо', { amb: false }],
];
(async () => {
  let ok = 0;
  for (const [name, hist, text, exp] of cases) {
    const r: any = await runExtractor({
      currentCard: card, messageText: text, hasPhoto: false, photoCaption: null, isAdminSender: false,
      recentHistory: hist, photoFileId: null, hoursSinceLastMessage: 0.1,
    });
    const fails: string[] = [];
    if (exp.amb !== undefined && (r.booking_reply_ambiguous === true) !== exp.amb) fails.push(`amb=${r.booking_reply_ambiguous}`);
    if (exp.yes !== undefined && (r.client_confirms_booking === 'yes') !== exp.yes) fails.push(`confirms=${r.client_confirms_booking}`);
    if (exp.undecided !== undefined && (r.client_undecided === true) !== exp.undecided) fails.push(`undecided=${r.client_undecided}`);
    if (exp.question !== undefined && (r.client_has_open_question === true) !== exp.question) fails.push(`question=${r.client_has_open_question}`);
    if (!fails.length) ok++;
    console.log(`${fails.length ? 'FAIL' : 'PASS'}  ${name.padEnd(40)} ${fails.join(' ')}`);
  }
  console.log(`\nИТОГО: ${ok}/${cases.length}`);
  if (ok < cases.length) process.exit(1);
})();
