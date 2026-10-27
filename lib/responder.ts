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

// Шаги, где точность стоит дороже экономии, остаются на полноразмерной
// модели; остальные (где ответ — по сути фиксированная фраза на этот шаг)
// переведены на mini. Два вида критичных шагов:
// 1) цена и подтверждения брони/хендоффа — клиент действует по тексту бота
//    (оплата, итоговое время; баг из прода с ценой без "за сеанс" — см.
//    scripts/dialogEval.ts);
// 2) "*_followup_chat" и ask_wants_to_book — на этих шагах Responder должен
//    по-настоящему ответить на произвольный вопрос клиента, а не просто
//    озвучить шаг. eval:dialog (2026-10-27, сценарий D) показал, что здесь
//    gpt-5.4-mini теряет содержание вопроса ("а что если нужно больше
//    одной встречи?" → общий вопрос вместо ответа) — поэтому эти шаги
//    тоже остаются на gpt-5.4.
const PRECISION_CRITICAL_STEPS: ReadonlySet<NextStep> = new Set<NextStep>([
  'quote_price',
  'confirm_slot_awaiting_payment',
  'confirm_consultation_booked',
  'campaign_handoff',
  'campaign_confirm_slot',
  'ask_wants_to_book',
  'waiting_slots_followup_chat',
  'booked_followup_chat',
  'declined_followup_chat',
  'campaign_followup_chat',
]);

function pickResponderModel(step: NextStep): string {
  return PRECISION_CRITICAL_STEPS.has(step) ? 'gpt-5.4' : 'gpt-5.4-mini';
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
    model: pickResponderModel(input.nextStep),
    temperature: 0.7,
    label: 'Responder',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
  });

  return text.trim();
}
