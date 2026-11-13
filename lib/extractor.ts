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
import { getMasterProfile, applyProfilePlaceholders, type MasterProfile } from './masters';

let cachedPromptWithCampaign: string | null = null;
let cachedPromptWithoutCampaign: string | null = null;

// Ядро (lib/prompts/extractor.txt) + блок кампаний. Всё, что зависит от
// мастера (прайс, направление), подставляется из профиля плейсхолдерами —
// отдельных overlay-файлов "поверх" ядра больше нет.
//
// includeCampaign=false пропускает campaignExtractor.txt целиком.
// campaignExtractor.txt сам прямо говорит "если ОБА поля (active_campaign
// И last_campaign) null — игнорируй весь этот файл" — то есть пропуск
// файла в этом случае НЕ меняет поведение модели, только экономит токены
// на обычных (не campaign) диалогах, которых большинство.
export function buildExtractorPrompt(
  profile: MasterProfile = getMasterProfile(),
  includeCampaign = true
): string {
  const core = fs.readFileSync(path.join(process.cwd(), 'lib', 'prompts', 'extractor.txt'), 'utf-8');
  if (!includeCampaign) {
    return applyProfilePlaceholders(core, profile);
  }
  const campaign = fs.readFileSync(path.join(process.cwd(), 'lib', 'prompts', 'campaignExtractor.txt'), 'utf-8');
  return applyProfilePlaceholders(`${core}\n\n${campaign}`, profile);
}

function getExtractorPrompt(includeCampaign: boolean): string {
  if (includeCampaign) return (cachedPromptWithCampaign ??= buildExtractorPrompt(undefined, true));
  return (cachedPromptWithoutCampaign ??= buildExtractorPrompt(undefined, false));
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
  // В этом сообщении есть вопрос/возражение/наблюдение, на которое нужно
  // ответить по существу (а не короткая реакция или ответ на вопрос Инки).
  client_has_open_question: boolean;
  // Client is postponing / unsure after the price, not refusing ("не знаю
  // пока", "подумаю"). Never counts as a final no.
  client_undecided: boolean;
  // Двоякий отклик на вопрос про запись («ок», «давайте попробуем»): не да и не нет.
  booking_reply_ambiguous?: boolean;
  // Client wants to talk to the master directly (asked, or accepted Inka's
  // offer to pass the request on).
  client_wants_master_contact: boolean;
  // Client asks when they can come / which windows are free (wants the
  // time before leaving contacts). See lib/stateMachine.ts bookingContactsOrSlots.
  client_asks_for_slots?: boolean;

  // v2 transient contract signals. They describe THIS message only.
  // Что модель ВИДИТ на референсе этого сообщения (без оценки пригодности).
  reference_color?: 'none' | 'accent' | 'equal' | 'dominant' | null;
  reference_is_realistic?: boolean | null;
  service_fit: ServiceFit;
  service_fit_reason: string | null;
  // Only meaningful alongside service_fit === 'needs_clarification' this
  // same message: true when the remaining ambiguity is a style/color call
  // only the master can make, not missing info a text question could
  // resolve. See lib/stateMachine.ts 'service_fit_master_judgment'.
  service_fit_needs_master_judgment: boolean;
  is_new_project_request: boolean;
  photo_purpose: PhotoPurpose;

  // Campaign mode only (see lib/campaignFlow.ts). Always present in the
  // JSON schema but only meaningful when ExtractorInput.activeCampaign was
  // non-null for this call.
  campaign_field_answer: string | null;
  // Automatic campaign <-> normal funnel switching (see lib/campaignFlow.ts
  // pauseCampaign/askCampaignReturn/confirmCampaignReturn/declineCampaignReturn).
  // campaign_exit_signal is only meaningful when ExtractorInput.activeCampaign
  // was non-null (client mid-campaign, this message clearly isn't about it
  // anymore) — code applies it immediately (pauseCampaign).
  // campaign_return_signal is only meaningful when ExtractorInput.lastCampaign
  // was non-null (client back in the normal funnel after a pause), and reads
  // in one of two ways depending on ExtractorInput.currentCard.campaign_return_pending
  // (see campaignExtractorOverlay.txt): not yet 'yes' → "does this message
  // raise the campaign topic" (code then asks a confirming question rather
  // than switching outright — askCampaignReturn); already 'yes' → "does this
  // message, as the direct answer to that just-asked question, confirm
  // switching" (code applies confirmCampaignReturn/declineCampaignReturn).
  // Always present in the JSON schema, both default to false otherwise.
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
  // Сколько часов прошло с последней активности по этой карточке (null —
  // неизвестно). Нужно, чтобы отличить возврат клиента с новым запросом от
  // продолжения разговора.
  hoursSinceLastMessage?: number | null;
  activeCampaign?: ActiveCampaignContext | null;
  // Set only when campaign_id is null but the client was previously paused
  // out of this campaign (card.campaign_last_id) — gives the Extractor the
  // title/offer it needs to recognize a message as renewed interest in that
  // same campaign (campaign_return_signal). pendingField is never meaningful
  // here and is always null.
  lastCampaign?: Pick<ActiveCampaignContext, 'title' | 'offer'> | null;
}

export async function runExtractor(input: ExtractorInput): Promise<ExtractorOutput> {
  // campaignExtractor.txt only ever matters when one of these is set — see
  // buildExtractorPrompt above.
  const needsCampaignPrompt = !!input.activeCampaign || !!input.lastCampaign;
  const systemPrompt = getExtractorPrompt(needsCampaignPrompt);

  const userContent = JSON.stringify(
    {
      current_card: input.currentCard,
      other_active_project: input.otherActiveProject ?? null,
      hours_since_last_message: input.hoursSinceLastMessage ?? null,
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

export function normalizeExtractorOutput(raw: ExtractorOutput): ExtractorOutput {
  const normalized = { ...raw } as ExtractorOutput;

  // These route constraints are deterministic, so enforce them in code even
  // if the model misses one in a complex message.
  const isTattooRequest = !!normalized.idea || !!normalized.size || !!normalized.category;
  if (
    normalized.category === 'large' ||
    normalized.category === 'body_fit' ||
    normalized.category === 'project' ||
    (getMasterProfile().tattooBooking === 'master' && isTattooRequest)
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
  const validRefColor = new Set(['none', 'accent', 'equal', 'dominant']);
  normalized.reference_color = validRefColor.has(normalized.reference_color as string)
    ? normalized.reference_color
    : null;
  normalized.reference_is_realistic =
    typeof normalized.reference_is_realistic === 'boolean' ? normalized.reference_is_realistic : null;
  normalized.service_fit_needs_master_judgment =
    normalized.service_fit_needs_master_judgment === true && normalized.service_fit === 'needs_clarification';
  normalized.is_new_project_request = normalized.is_new_project_request === true;
  normalized.client_has_open_question = normalized.client_has_open_question === true;
  normalized.client_undecided = normalized.client_undecided === true && normalized.client_confirms_booking !== 'no';
  normalized.booking_reply_ambiguous =
    normalized.booking_reply_ambiguous === true &&
    normalized.client_confirms_booking == null &&
    normalized.client_undecided !== true;
  normalized.client_wants_master_contact = normalized.client_wants_master_contact === true;
  normalized.client_asks_for_slots = normalized.client_asks_for_slots === true;
  normalized.photo_purpose = normalized.photo_purpose ?? null;
  normalized.service_fit = normalized.service_fit ?? null;
  normalized.campaign_field_answer =
    typeof normalized.campaign_field_answer === 'string' && normalized.campaign_field_answer.trim()
      ? normalized.campaign_field_answer.trim()
      : null;
  normalized.campaign_exit_signal = normalized.campaign_exit_signal === true;
  normalized.campaign_return_signal = normalized.campaign_return_signal === true;

  return applyColorRealismRule(normalized, getMasterProfile());
}

// Мастер не делает цветной реализм (профиль: excludesColorRealism). Модель
// только описывает, что видит на референсе (цвет доминирует + реализм), а
// решение принимает код: цветной реализм = сразу стоп. Если модель уже
// сказала "allowed" (клиент сам согласился на ч/б или чёрную основу),
// не перебиваем.
export function applyColorRealismRule(
  out: ExtractorOutput,
  profile: { excludesColorRealism?: boolean }
): ExtractorOutput {
  if (
    profile.excludesColorRealism &&
    out.reference_color === 'dominant' &&
    out.reference_is_realistic === true &&
    out.service_fit !== 'allowed' &&
    // Фото своей старой цветной татуировки под перекрытие — не заказ
    // цветного реализма.
    out.existing_tattoo !== 'cover' &&
    out.existing_tattoo !== 'modification'
  ) {
    return {
      ...out,
      service_fit: 'not_offered',
      service_fit_reason: 'color realism reference (code rule: master does not do color realism)',
      service_fit_needs_master_judgment: false,
    };
  }
  return out;
}
