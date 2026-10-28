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
import { applyProfilePlaceholders, getMasterProfile, type MasterProfile } from './masters';
import type { RecentDialogTurn } from './dialogLog';
import type { CampaignConfig } from './campaigns';

let cachedPrompt: string | null = null;

// Ядро (lib/prompts/responder.txt) + блок кампаний; всё, что зависит от
// мастера, приходит из профиля плейсхолдерами (lib/masters).
export function buildResponderPrompt(profile: MasterProfile = getMasterProfile()): string {
  const core = fs.readFileSync(path.join(process.cwd(), 'lib', 'prompts', 'responder.txt'), 'utf-8');
  // Действует только при campaign != null во входных данных.
  const campaign = fs.readFileSync(path.join(process.cwd(), 'lib', 'prompts', 'campaignResponder.txt'), 'utf-8');
  return applyProfilePlaceholders(`${core}\n\n${campaign}`, profile);
}

function getResponderPrompt(): string {
  return (cachedPrompt ??= buildResponderPrompt());
}

// price_factors = "<почему так — для клиента> || <внутреннее для мастера>"
// (см. ШАГ 2b в lib/prompts/extractor.txt). Responder получает только левую
// часть и, отдельно, прикидку итога — категория, оси и число сеансов до
// него не доходят вообще, а не "запрещены инструкцией".
export function clientPriceReasons(priceFactors: string | null): string | null {
  if (!priceFactors) return null;
  const sep = priceFactors.indexOf('||');
  // Старые карточки без разделителя целиком внутренние — не показываем.
  if (sep < 0) return null;
  const reasons = priceFactors.slice(0, sep).trim();
  return reasons || null;
}

// "итог ≈ 12000–30000₪" / "итог от 33000₪" из внутренней части. Нет такой
// записи (в том числе "итог: нет данных") — null: итог Responder не называет.
export function projectTotalEstimate(priceFactors: string | null): string | null {
  if (!priceFactors) return null;
  const sep = priceFactors.indexOf('||');
  if (sep < 0) return null;
  const m = priceFactors.slice(sep + 2).match(/итог\s*[≈~]?\s*((?:от\s*)?\d[\d\s]*(?:[–-]\s*\d[\d\s]*)?₪)/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

function cardForResponder(card: ClientCard) {
  const { price_factors, ...rest } = card;
  return {
    ...rest,
    price_reasons: clientPriceReasons(price_factors),
    project_total_estimate: projectTotalEstimate(price_factors),
  };
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
  // a photo with no caption). See lib/prompts/responder.txt, ЯЗЫК:
  // last_client_message still wins whenever it's present.
  telegramLanguageCode?: string | null;
}

// Шаги, где точность стоит дороже экономии, остаются на полноразмерной
// модели; остальные (где ответ — по сути фиксированная фраза на этот шаг)
// переведены на mini. Два вида критичных шагов:
// 1) цена и подтверждения брони/хендоффа — клиент действует по тексту бота
//    (оплата, итоговое время; баг из прода с ценой без "за сеанс" — см.
//    scripts/dialogEval.ts);
// 2) "*_followup_chat" (включая price_followup_chat) и ask_wants_to_book — на этих шагах Responder должен
//    по-настоящему ответить на произвольный вопрос клиента, а не просто
//    озвучить шаг. eval:dialog (2026-10-27, сценарий D) показал, что здесь
//    gpt-5.4-mini теряет содержание вопроса ("а что если нужно больше
//    одной встречи?" → общий вопрос вместо ответа) — поэтому эти шаги
//    тоже остаются на gpt-5.4.
// 3) campaign_intro/campaign_ask_field — здесь Responder пересказывает
//    offer кампании (lib/campaigns.ts, обычно на русском) клиенту на ЕГО
//    языке. CI (eval:campaign-dialog, 2026-10-27) поймал на mini смешение
//    языков: ответ на английском оставил непереведённое русское слово
//    ("расходники"). Полный перевод офера — та же категория риска, что и
//    (2), поэтому эти два шага тоже на gpt-5.4; остальные campaign_*-шаги
//    (слоты, подтверждения полей) — заготовленные фразы, mini их не ломает.
const PRECISION_CRITICAL_STEPS: ReadonlySet<NextStep> = new Set<NextStep>([
  'quote_price',
  'confirm_slot_awaiting_payment',
  'confirm_consultation_booked',
  'campaign_handoff',
  'campaign_confirm_slot',
  'ask_wants_to_book',
  'price_followup_chat',
  'waiting_slots_followup_chat',
  'booked_followup_chat',
  'declined_followup_chat',
  'campaign_followup_chat',
  'campaign_intro',
  'campaign_ask_field',
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
      client_card: cardForResponder(input.clientCard),
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
