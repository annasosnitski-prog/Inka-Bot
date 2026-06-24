// ============================================================
// INKA-BOT — Responder
// Второй (и последний) вызов OpenAI. Получает только NEXT_STEP +
// карточку клиента + последнее сообщение — пишет живой текст ответа.
// НЕ выбирает следующий шаг, только облекает его в слова.
// Промпт лежит в responderPrompt.txt (читается раз, кэшируется).
// ============================================================

import fs from 'fs';
import path from 'path';
import type { ClientCard, NextStep } from './stateMachine';

let cachedPrompt: string | null = null;

function getResponderPrompt(): string {
  if (cachedPrompt) return cachedPrompt;
  const promptPath = path.join(process.cwd(), 'lib', 'responderPrompt.txt');
  cachedPrompt = fs.readFileSync(promptPath, 'utf-8');
  return cachedPrompt;
}

export interface ResponderInput {
  nextStep: NextStep;
  clientCard: ClientCard;
  lastClientMessage: string | null;
  manualMode: boolean; // true = Аня сама пишет от первого лица
}

export async function runResponder(input: ResponderInput): Promise<string> {
  // silence_blocked — отдельная ветка, экономим вызов к OpenAI и
  // деньги: молчание не требует творчества, это решает чистый код.
  if (input.nextStep === 'silence_blocked') {
    return '';
  }

  const systemPrompt = getResponderPrompt();

  const userContent = JSON.stringify(
    {
      next_step: input.nextStep,
      client_card: input.clientCard,
      last_client_message: input.lastClientMessage,
      manual_mode: input.manualMode,
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
      model: 'gpt-5.4',
      temperature: 0.7, // тут наоборот хотим живости, не 0 как у Extractor
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Responder OpenAI call failed: ${response.status} ${errText}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content;

  if (!text) {
    throw new Error('Responder: empty response from OpenAI');
  }

  return text.trim();
}
