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
  const template = fs.readFileSync(promptPath, 'utf-8');
  const base = template.replace('{{PRICING_RULES}}', getPricingRules());
  // Contract overlay is intentionally appended last: it only overrides the
  // output contract / new routing signals while preserving the battle-tested
  // pricing and extraction rules in the production prompt.
  const overlay = fs.readFileSync(overlayPath, 'utf-8');
  cachedPrompt = `${base}\n\n${overlay}`;
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
}

export interface ExtractorInput {
  currentCard: Partial<ClientCard>;
  messageText: string | null;
  hasPhoto: boolean;
  photoCaption: string | null;
  isAdminSender: boolean;
  recentHistory: RecentDialogTurn[];
  photoFileId: string | null;
}

export async function runExtractor(input: ExtractorInput): Promise<ExtractorOutput> {
  const systemPrompt = getExtractorPrompt();

  const userContent = JSON.stringify(
    {
      current_card: input.currentCard,
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

  return normalized;
}
