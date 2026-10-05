// ============================================================
// INKA-BOT — Extractor
// Первый из двух вызовов OpenAI. Узкая задача: вытащить поля
// из сообщения клиента. НЕ пишет ответ, НЕ выбирает NEXT_STEP.
// ============================================================

import fs from 'fs';
import path from 'path';
import type {
  Intent,
  ExistingTattoo,
  YesNo,
  Category,
  ClientCard,
  ContactChannel,
  ServiceFit,
  PhotoPurpose,
} from './stateMachine';
import { callOpenAIChat, type ChatContentPart } from './openai';
import { getTelegramFileDataUrl } from './telegramApi';
import type { RecentDialogTurn } from './dialogLog';
import { getPricingRules } from './pricingRules';

let cachedPrompt: string | null = null;

function getExtractorPrompt(): string {
  if (cachedPrompt) return cachedPrompt;
  const promptPath = path.join(process.cwd(), 'lib', 'extractorPrompt.txt');
  const overlayPath = path.join(process.cwd(), 'lib', 'extractorContractV2.txt');
  const campaignOverlayPath = path.join(process.cwd(), 'lib', 'campaignExtractorOverlay.txt');
  const template = fs.readFileSync(promptPath, 'utf-8');
  const base = template.replace('{{PRICING_RULES}}', getPricingRules());
  // Contract overlay is intentionally appended last: it only overrides the
  // output contract / new routing signals while preserving the battle-tested
  // pricing and extraction rules in the production prompt.
  const overlay = fs.readFileSync(overlayPath, 'utf-8');
  // Campaign overlay is appended unconditionally too, but it only takes
  // effect when active_campaign is non-null in the per-call input (see
  // ExtractorInput.activeCampaign below) — otherwise the model is told to
  // ignore it entirely, same pattern as the v2 overlay above.
  const campaignOverlay = fs.readFileSync(campaignOverlayPath, 'utf-8');
  cachedPrompt = `${base}\n\n${overlay}\n\n${campaignOverlay}`;
  return cachedPrompt;
}

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
  price_factors: string | null;
  phone: string | null;
  client_name: string | null;
  contact_channel: ContactChannel;
  social_link: string | null;
  is_prompt_injection: boolean;
  is_out_of_scope: boolean;
  is_wrong_layout: boolean;
  has_photo_this_message: boolean;
  photo_has_caption: boolean;
  client_picked_slot_id: string | null;
  client_wants_other_slots: boolean;
  client_asks_for_more_slots: boolean;
  client_wants_to_reschedule: boolean;
  client_confirms_booking: 'yes' | 'no' | null;

  // v2 transient contract signals. They describe THIS message only.
  service_fit: ServiceFit;
  service_fit_reason: string | null;
  is_new_project_request: boolean;
  photo_purpose: PhotoPurpose;

  // Campaign mode only (see lib/campaignFlow.ts). Always present in the
  // JSON schema but only meaningful when ExtractorInput.activeCampaign was
  // non-null for this call.
  campaign_field_answer: string | null;
  // Automatic campaign <-> normal funnel switching (see lib/campaignFlow.ts
  // pauseCampaign/resumeCampaign). campaign_exit_signal is only meaningful
  // when ExtractorInput.activeCampaign was non-null (client mid-campaign,
  // this message clearly isn't about it anymore). campaign_return_signal is
  // only meaningful when ExtractorInput.lastCampaign was non-null (client
  // back in the normal funnel, this message clearly signals renewed
  // interest in the campaign they were paused from). Always present in the
  // JSON schema, both default to false otherwise.
  campaign_exit_signal: boolean;
  campaign_return_signal: boolean;
}

// Minimal campaign context handed to the Extractor so it knows a) this is
// not the normal tattoo funnel and b) which generic field the client's
// message is presumed to be answering right now. Deliberately generic —
// no campaign-specific copy lives in code, only data from lib/campaigns.ts.
export interface ActiveCampaignContext {
  title: string;
  offer: string;
  pendingField: string | null;
}

// Краткая сводка ВТОРОГО активного проекта того же клиента (если есть) —
// не полная карточка, только то, что нужно, чтобы отличить его от
// current_card. Без этого поля Extractor вообще не знает, что у клиента
// есть второй проект, и не может распознать сообщение, которое на самом
// деле про него, а не про current_card (см. pages/api/telegram.ts).
export interface OtherActiveProjectSummary {
  idea: string | null;
  placement: string | null;
  category: ClientCard['category'];
  lead_status: ClientCard['lead_status'];
}

export interface ExtractorInput {
  currentCard: Partial<ClientCard>;
  messageText: string | null;
  hasPhoto: boolean;
  photoCaption: string | null;
  isAdminSender: boolean;
  recentHistory: RecentDialogTurn[];
  photoFileId: string | null;
  otherActiveProject?: OtherActiveProjectSummary | null;
  activeCampaign?: ActiveCampaignContext | null;
  // Set only when campaign_id is null but the client was previously paused
  // out of this campaign (card.campaign_last_id) — gives the Extractor the
  // title/offer it needs to recognize a message as renewed interest in that
  // same campaign (campaign_return_signal). pendingField is never meaningful
  // here and is always null.
  lastCampaign?: Pick<ActiveCampaignContext, 'title' | 'offer'> | null;
}

export async function runExtractor(input: ExtractorInput): Promise<ExtractorOutput> {
  const systemPrompt = getExtractorPrompt();

  const userContent = JSON.stringify(
    {
      current_card: input.currentCard,
      other_active_project: input.otherActiveProject ?? null,
      active_campaign: input.activeCampaign ?? null,
      last_campaign: input.lastCampaign ?? null,
      is_admin_sender: input.isAdminSender,
      recent_history: input.recentHistory,
      message: {
        text: input.messageText,
        has_photo: input.hasPhoto,
        photo_caption: input.photoCaption,
      },
    },
    null,
    2
  );

  // v2: booked photos are also shown to vision. The overlay strictly limits
  // booked-image use to photo_purpose classification, which lets us tell a
  // real payment proof from a tattoo reference instead of treating ANY photo
  // after booking as money received.
  let userMessageContent: string | ChatContentPart[] = userContent;
  if (input.photoFileId) {
    const photoDataUrl = await getTelegramFileDataUrl(input.photoFileId);
    if (photoDataUrl) {
      userMessageContent = [
        { type: 'text', text: userContent },
        { type: 'image_url', image_url: { url: photoDataUrl } },
      ];
    }
  }

  const rawText = await callOpenAIChat({
    model: 'gpt-5.4-mini',
    temperature: 0,
    responseFormatJson: true,
    label: 'Extractor',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessageContent },
    ],
  });

  let parsed: ExtractorOutput;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`Extractor: failed to parse JSON. Raw: ${rawText}`);
  }

  return normalizeExtractorOutput(parsed);
}

function normalizeExtractorOutput(raw: ExtractorOutput): ExtractorOutput {
  const normalized = { ...raw } as ExtractorOutput;

  // These route constraints are deterministic, so enforce them in code even
  // if the model misses one in a complex message.
  if (
    normalized.category === 'large' ||
    normalized.category === 'body_fit' ||
    normalized.category === 'project'
  ) {
    normalized.direct_tattoo_allowed = 'no';
    normalized.consultation_needed = 'yes';
  }

  const validServiceFit = new Set<ServiceFit>([
    'allowed',
    'needs_clarification',
    'not_offered',
    null,
  ]);
  if (!validServiceFit.has(normalized.service_fit ?? null)) normalized.service_fit = null;

  const validPhotoPurpose = new Set<PhotoPurpose>([
    'payment_proof',
    'reference',
    'other',
    'unknown',
    null,
  ]);
  if (!validPhotoPurpose.has(normalized.photo_purpose ?? null)) normalized.photo_purpose = null;

  normalized.service_fit_reason = normalized.service_fit_reason ?? null;
  normalized.is_new_project_request = normalized.is_new_project_request === true;
  normalized.photo_purpose = normalized.photo_purpose ?? null;
  normalized.service_fit = normalized.service_fit ?? null;
  normalized.campaign_field_answer =
    typeof normalized.campaign_field_answer === 'string' && normalized.campaign_field_answer.trim()
      ? normalized.campaign_field_answer.trim()
      : null;
  normalized.campaign_exit_signal = normalized.campaign_exit_signal === true;
  normalized.campaign_return_signal = normalized.campaign_return_signal === true;

  return normalized;
}
