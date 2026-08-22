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
import { callOpenAIChat } from './openai';
import { getDepositAmount } from './paymentConfig';
import type { RecentDialogTurn } from './dialogLog';

let cachedPrompt: string | null = null;

function getResponderPrompt(): string {
  if (cachedPrompt) return cachedPrompt;
  const promptPath = path.join(process.cwd(), 'lib', 'responderPrompt.txt');
  const raw = fs.readFileSync(promptPath, 'utf-8');
  cachedPrompt = raw.replace(/\{\{DEPOSIT\}\}/g, getDepositAmount());
  return cachedPrompt;
}

export interface ResponderInput {
  nextStep: NextStep;
  clientCard: ClientCard;
  lastClientMessage: string | null;
  recentHistory: RecentDialogTurn[]; // последние ~6 обменов клиент↔Инка, БЕЗ текущего сообщения — для тона/непрерывности, не для новой логики (маршрут уже решён state machine)
  slotsDisplay: string[] | null; // человекочитаемые версии slot_options (дата+время), для показа клиенту
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
      recent_history: input.recentHistory,
      slots_display: input.slotsDisplay,
    },
    null,
    2
  );

  const text = await callOpenAIChat({
    model: 'gpt-5.4',
    temperature: 0.7, // тут наоборот хотим живости, не 0 как у Extractor
    label: 'Responder',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
  });

  return text.trim();
}
