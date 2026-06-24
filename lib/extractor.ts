// ============================================================
// INKA-BOT — Extractor
// Первый из двух вызовов OpenAI. Узкая задача: вытащить поля
// из сообщения клиента. НЕ пишет ответ, НЕ выбирает NEXT_STEP.
// Промпт лежит в extractorPrompt.txt (читается один раз при холодном
// старте функции и кэшируется в памяти процесса).
// ============================================================

import fs from 'fs';
import path from 'path';
import type {
  Intent,
  ExistingTattoo,
  YesNo,
  Category,
  ContactPreference,
  ClientCard,
} from './stateMachine';

// ----------------------------------------------------------
// Промпт читаем один раз и держим в памяти (холодный старт
// serverless-функции прочитает файл, тёплые вызовы — нет).
// ----------------------------------------------------------
let cachedPrompt: string | null = null;

function getExtractorPrompt(): string {
  if (cachedPrompt) return cachedPrompt;
  const promptPath = path.join(process.cwd(), 'lib', 'extractorPrompt.txt');
  cachedPrompt = fs.readFileSync(promptPath, 'utf-8');
  return cachedPrompt;
}

// ----------------------------------------------------------
// То, что Extractor реально возвращает (сырой JSON от модели).
// Это подмножество ClientCard + MessageSignals — без полей,
// которыми Extractor не управляет (lead_status, spam_count,
// chosen_slot_id, telegram_id, slot_options, photos_count).
// ----------------------------------------------------------
export interface ExtractorOutput {
  intent: Intent;
  idea: string | null;
  placement: string | null;
  size: string | null;
  existing_tattoo: ExistingTattoo;
  skin_notes: string | null;
  first_tattoo: YesNo;
  category: Category;
  active_work_time_estimate: '<=3h' | '>3h' | 'unknown' | null;
  direct_tattoo_allowed: YesNo;
  consultation_needed: YesNo;
  price_quoted: string | null;
  price_explained: YesNo;
  contact_preference: ContactPreference;
  contact_value: string | null;
  is_prompt_injection: boolean;
  is_out_of_scope: boolean;
  has_photo_this_message: boolean;
  photo_has_caption: boolean;
  client_picked_slot_id: string | null;
  client_wants_other_slots: boolean;
  client_asks_for_more_slots: boolean;
  client_wants_to_reschedule: boolean;
  client_confirms_booking: 'yes' | 'no' | null;
}

// ----------------------------------------------------------
// Вход функции: текущая карточка (как контекст для модели) +
// сырое сообщение клиента + флаг is_admin_sender (вычислен кодом).
// ----------------------------------------------------------
export interface ExtractorInput {
  currentCard: Partial<ClientCard>;
  messageText: string | null; // текст сообщения, или null если только фото без подписи
  hasPhoto: boolean;
  photoCaption: string | null; // подпись к фото, если есть
  isAdminSender: boolean;
}

export async function runExtractor(input: ExtractorInput): Promise<ExtractorOutput> {
  const systemPrompt = getExtractorPrompt();

  const userContent = JSON.stringify(
    {
      current_card: input.currentCard,
      is_admin_sender: input.isAdminSender,
      message: {
        text: input.messageText,
        has_photo: input.hasPhoto,
        photo_caption: input.photoCaption,
      },
    },
    null,
    2
  );

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-5.4-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Extractor OpenAI call failed: ${response.status} ${errText}`);
  }

  const data = await response.json();
  const rawText = data.choices?.[0]?.message?.content;

  if (!rawText) {
    throw new Error('Extractor: empty response from OpenAI');
  }

  let parsed: ExtractorOutput;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`Extractor: failed to parse JSON. Raw: ${rawText}`);
  }

  return normalizeExtractorOutput(parsed);
}

// ----------------------------------------------------------
// Защитный слой: не доверяем модели на 100%, подчищаем то, что
// легко проверить кодом без LLM.
// ----------------------------------------------------------
function normalizeExtractorOutput(raw: ExtractorOutput): ExtractorOutput {
  const normalized = { ...raw };

  // category "large" | "body_fit" | "project" обязаны давать
  // consultation_needed = "yes" — досчитываем кодом, не доверяя
  // модели в краевых случаях.
  if (
    normalized.category === 'large' ||
    normalized.category === 'body_fit' ||
    normalized.category === 'project'
  ) {
    normalized.direct_tattoo_allowed = 'no';
    normalized.consultation_needed = 'yes';
  }

  return normalized;
}
