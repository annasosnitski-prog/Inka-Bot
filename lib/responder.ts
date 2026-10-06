// ============================================================
// INKA-BOT — Responder
// Второй (и последний) вызов OpenAI. Получает только NEXT_STEP +
// карточку клиента + последнее сообщение — пишет живой текст ответа.
// НЕ выбирает следующий шаг, только облекает его в слова.
// ============================================================

import fs from 'fs';
import path from 'path';
import type { ClientCard, NextStep } from './stateMachine';
import { callOpenAIChat } from './openai';
import { getDepositAmount } from './paymentConfig';
import type { RecentDialogTurn } from './dialogLog';
import type { CampaignConfig } from './campaigns';

let cachedPrompt: string | null = null;

function getResponderPrompt(): string {
  if (cachedPrompt) return cachedPrompt;
  const promptPath = path.join(process.cwd(), 'lib', 'responderPrompt.txt');
  const overlayPath = path.join(process.cwd(), 'lib', 'responderVoiceV2.txt');
  const campaignOverlayPath = path.join(process.cwd(), 'lib', 'campaignResponderOverlay.txt');
  const raw = fs.readFileSync(promptPath, 'utf-8');
  const base = raw.replace(/\{\{DEPOSIT\}\}/g, getDepositAmount());
  // Appended last on purpose: v2 overrides only the voice/archetype contract
  // and the new NEXT_STEP wording, preserving existing operational rules.
  const overlay = fs.readFileSync(overlayPath, 'utf-8');
  // Campaign overlay is appended unconditionally too, but only takes effect
  // when the per-call input's campaign is non-null — otherwise the model is
  // told to ignore it entirely, same pattern as the v2 overlay above.
  const campaignOverlay = fs.readFileSync(campaignOverlayPath, 'utf-8');
  cachedPrompt = `${base}\n\n${overlay}\n\n${campaignOverlay}`;
  return cachedPrompt;
}

export interface ResponderInput {
  nextStep: NextStep;
  clientCard: ClientCard;
  lastClientMessage: string | null;
  recentHistory: RecentDialogTurn[];
  slotsDisplay: string[] | null;
  campaign?: CampaignConfig | null;
  campaignPendingField?: string | null;
  // Set only for NEXT_STEP = campaign_return_confirm (see
  // lib/stateMachine.ts, lib/campaignFlow.ts askCampaignReturn): the
  // campaign the client is being asked whether to switch back to. campaign
  // itself stays null on this step (the client hasn't actually re-entered
  // it yet), so this is the only way Responder knows what to name.
  lastCampaign?: CampaignConfig | null;
  // Telegram's own language_code for this user (from message.from, e.g.
  // "ru"/"he"/"en") — a FALLBACK hint only, for turns where there's no
  // client text to detect language from at all (deep-link /start trigger,
  // a photo with no caption). See responderPrompt.txt's ЯЗЫК section:
  // last_client_message still wins whenever it's present.
  telegramLanguageCode?: string | null;
}

export async function runResponder(input: ResponderInput): Promise<string> {
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
      campaign: input.campaign ?? null,
      campaign_pending_field: input.campaignPendingField ?? null,
      last_campaign: input.lastCampaign ?? null,
      telegram_language_code: input.telegramLanguageCode ?? null,
    },
    null,
    2
  );

  const text = await callOpenAIChat({
    model: 'gpt-5.4',
    temperature: 0.7,
    label: 'Responder',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
  });

  return text.trim();
}
