// ============================================================
// INKA-BOT — State Machine v2 contract
// Pure TypeScript. No LLM calls.
// Extractor describes the current message/project; this module owns routing.
// ============================================================

import { routeCampaign, getCampaignCardPatch } from './campaignFlow';

export type Intent =
  | 'admin_test'
  | 'idea'
  | 'price'
  | 'booking'
  | 'consultation'
  | 'existing_tattoo'
  | 'out_of_scope'
  | 'prompt_injection'
  | 'unclear';

export type LeadStatus =
  | 'new'
  | 'diagnosing'
  | 'estimated'
  | 'wants_booking'
  | 'slots_shown'
  | 'consultation_booked'
  | 'tattoo_booked_waiting_payment'
  | 'waiting_slots'
  | 'waiting_slots_pinged'
  | 'blocked';

export type Category =
  | 'mini'
  | 'small'
  | 'medium'
  | 'medium_big'
  | 'large'
  | 'body_fit'
  | 'project'
  | null;

export type YesNo = 'yes' | 'no' | null;
export type ExistingTattoo = 'no' | 'cover' | 'modification' | 'scar_work' | null;
export type ContactChannel = 'telegram' | 'whatsapp' | null;
export type PaymentStatus = 'none' | 'waiting_prepayment' | 'waiting_confirmation' | 'paid' | null;
export type ClientType =
  | '1_undefined'
  | '2_reference'
  | '3_price_only'
  | '4_wants_meeting'
  | '5_anxious'
  | null;

// Transient message-level routing signals introduced in v2.
export type ServiceFit = 'allowed' | 'needs_clarification' | 'not_offered' | null;
export type PhotoPurpose = 'payment_proof' | 'reference' | 'other' | 'unknown' | null;

export interface ClientCard {
  telegram_id: number;
  intent: Intent;
  lead_status: LeadStatus;
  category: Category;
  idea: string | null;
  size: string | null;
  placement: string | null;
  first_tattoo: YesNo;
  existing_tattoo: ExistingTattoo;
  direct_tattoo_allowed: YesNo;
  consultation_needed: YesNo;
  active_work_time_estimate: string | null;
  price_quoted: string | null;
  price_explained: YesNo;
  price_factors: string | null;
  price_shown: YesNo;
  wants_to_book: YesNo;
  decline_followup_asked: YesNo;
  phone: string | null;
  client_name: string | null;
  contact_channel: ContactChannel;
  social_link: string | null;
  social_asked: YesNo;
  payment_status: PaymentStatus;
  client_type: ClientType;
  skin_notes: string | null;
  spam_count: 0 | 1 | 2 | 3;
  chosen_slot_id: string | null;
  slot_options: string[] | null;
  booked_slot_display: string | null;
  booked_slot_start_iso: string | null;
  payment_reminder_sent: YesNo;
  booked_at: string | null;
  payment_reminder_early_sent: YesNo;
  reference_asked: YesNo;
  photos_count: number;
  has_photo_this_message: boolean;
  photo_has_caption: boolean;
  force_client_mode: YesNo;
  // Persisted per-project gate: unlike the transient signals below, this is
  // a fact about the CURRENT project, carried across turns by code — not by
  // asking the Extractor to remember it from recent_history.
  service_fit: ServiceFit;
  // Guards new_project_after_booking from re-pinging the master on every
  // follow-up message about the same overflow project. A genuine SECOND
  // project now gets its own Airtable record (see pages/api/telegram.ts,
  // which resolves it before this gate ever runs) — this NextStep and flag
  // only fire for a rare THIRD concurrent project, where a real hand-off
  // (not a new record) is still the right call.
  second_project_flagged: YesNo;
  // Campaign/recruitment deep-link mode (see lib/campaigns.ts,
  // lib/campaignFlow.ts). null = normal client funnel, unchanged. Set once
  // from a recognized /start <campaign_id> payload and persisted across
  // turns + serverless restarts via Airtable (campaign_id field).
  campaign_id: string | null;
  // Generic key->value store of campaign required_info/optional_info
  // answers, keyed by the campaign's own field names. Code only reads
  // presence/absence of keys — never interprets the values.
  campaign_collected: Record<string, string> | null;
  // Set once the campaign's booking_mode handoff message has been sent —
  // routes all further messages to campaign_followup_chat instead of
  // re-running the collection loop.
  campaign_handoff_sent: YesNo;
  // Set when the client is auto-switched OUT of an active campaign back
  // into the normal funnel (see lib/campaignFlow.ts pauseCampaign) — holds
  // the campaign id so a confirmed return later in the conversation
  // (askCampaignReturn/confirmCampaignReturn) can restore campaign_collected
  // instead of starting the campaign questionnaire over. null outside of
  // this paused state.
  campaign_last_id: string | null;
  // 'yes' while Inka has just asked the client whether to actually switch
  // back to campaign_last_id (campaign_return_confirm) and is waiting for
  // an explicit answer — see pages/api/telegram.ts. null the rest of the
  // time, including once the client confirms or declines.
  campaign_return_pending: YesNo;
}

export interface MessageSignals {
  is_admin_sender: boolean;
  is_prompt_injection: boolean;
  is_out_of_scope: boolean;
  is_wrong_layout: boolean;
  client_picked_slot_id: string | null;
  client_wants_other_slots: boolean;
  client_asks_for_more_slots: boolean;
  client_wants_to_reschedule: boolean;
  client_confirms_booking: YesNo;
  // v2: all are current-message signals, never persisted as project facts.
  service_fit?: ServiceFit;
  service_fit_reason?: string | null;
  is_new_project_request?: boolean;
  photo_purpose?: PhotoPurpose;
  // Campaign mode only: this message's answer to the currently pending
  // campaign field (see lib/campaignFlow.ts), already merged into
  // card.campaign_collected by pages/api/telegram.ts before getNextStep
  // runs. Present here only so getCampaignCardPatch has the same shape as
  // every other transient signal — the merge itself already happened.
  campaign_field_answer?: string | null;
}

export type NextStep =
  | 'admin_mode'
  | 'silence_blocked'
  | 'handle_prompt_injection'
  | 'wrong_keyboard_layout'
  | 'handle_out_of_scope_warning_1'
  | 'handle_out_of_scope_warning_2'
  | 'handle_out_of_scope_block'
  | 'handle_service_not_offered'
  | 'clarify_service_fit'
  | 'new_project_after_booking'
  | 'clarify_booked_photo'
  | 'handle_photo_no_caption'
  | 'ask_idea'
  | 'ask_placement'
  | 'ask_size'
  | 'ask_existing_tattoo_or_skin'
  | 'ask_skin_notes_detail'
  | 'ask_reference_photo'
  | 'quote_price'
  | 'ask_wants_to_book'
  | 'ask_first_tattoo'
  | 'ask_phone'
  | 'ask_name'
  | 'ask_contact_channel'
  | 'ask_social'
  | 'show_tattoo_slots'
  | 'show_consultation_slots'
  | 'slot_taken_pick_again'
  | 'unclear_slot_choice'
  | 'slot_change_requested_waiting'
  | 'no_more_slots_waiting'
  | 'waiting_slots_followup_chat'
  | 'reschedule_requested_ping_master'
  | 'confirm_slot_awaiting_payment'
  | 'confirm_consultation_booked'
  | 'payment_screenshot_received'
  | 'booked_followup_chat'
  | 'all_done'
  | 'declined_followup_chat'
  // Campaign/recruitment mode (see lib/campaignFlow.ts). Generic across all
  // campaigns — which campaign and which field is being asked travels
  // alongside the card/step, never encoded in the step name itself.
  | 'campaign_intro'
  | 'campaign_ask_field'
  | 'campaign_handoff'
  | 'campaign_show_slots'
  | 'campaign_no_slots'
  | 'campaign_confirm_slot'
  | 'campaign_followup_chat'
  // Client is back in the normal funnel but just got asked whether to
  // actually switch to the campaign they were paused from (see
  // card.campaign_return_pending, lib/campaignFlow.ts). Persists — i.e.
  // getNextStep keeps returning it — until the client's answer resolves it
  // one way or the other.
  | 'campaign_return_confirm';

function hasSlots(card: ClientCard): boolean {
  return !!card.slot_options && card.slot_options.length > 0;
}

export function getNextStep(card: ClientCard, signals: MessageSignals): NextStep {
  // Hard guards first.
  if (signals.is_admin_sender && card.force_client_mode !== 'yes') return 'admin_mode';
  if (card.lead_status === 'blocked') return 'silence_blocked';
  if (signals.is_prompt_injection) return 'handle_prompt_injection';
  if (signals.is_wrong_layout) return 'wrong_keyboard_layout';

  if (signals.is_out_of_scope) {
    if (card.spam_count === 0) return 'handle_out_of_scope_warning_1';
    if (card.spam_count === 1) return 'handle_out_of_scope_warning_2';
    return 'handle_out_of_scope_block';
  }

  // Campaign/recruitment deep-link mode takes over entirely — it has its
  // own generic, config-driven routing (lib/campaignFlow.ts) and never
  // falls through into the tattoo-pricing funnel below. A null result
  // means campaign_id doesn't resolve to a known/active campaign (should
  // not normally happen once set — see pages/api/telegram.ts activation
  // guard — but a deactivated campaign mid-flight falls back safely here
  // instead of getting stuck).
  if (card.campaign_id) {
    const campaignRouting = routeCampaign(card, signals);
    if (campaignRouting) return campaignRouting.step;
  }

  // Client is in the normal funnel, but pages/api/telegram.ts just asked
  // (or is still asking) whether to switch back to campaign_last_id — keep
  // returning this step so the question never silently drops; code outside
  // getNextStep resolves campaign_return_pending from the client's answer
  // before the NEXT call to getNextStep, so this is never a real infinite
  // loop, only a persisted "still waiting" state.
  if (!card.campaign_id && card.campaign_return_pending === 'yes') {
    return 'campaign_return_confirm';
  }

  // v2 service gate: unsupported work must never reach quote/booking. The
  // persisted card.service_fit is the source of truth across turns — a
  // fresh per-message signal only overrides it when the Extractor actually
  // raised the question THIS message; otherwise the code keeps whatever was
  // already decided, instead of asking the LLM to "remember" it itself.
  const effectiveServiceFit = signals.service_fit ?? card.service_fit;
  if (effectiveServiceFit === 'not_offered') return 'handle_service_not_offered';
  if (effectiveServiceFit === 'needs_clarification') return 'clarify_service_fit';

  // Already-booked conversations are isolated from the acquisition funnel.
  const isAlreadyBooked =
    card.lead_status === 'tattoo_booked_waiting_payment' ||
    card.lead_status === 'consultation_booked';

  if (isAlreadyBooked) {
    // By the time this card reaches getNextStep, telegram.ts has already
    // resolved a genuine SECOND project onto its own record — this branch
    // never sees that case. What lands here is the rarer THIRD concurrent
    // project, where a real hand-off (not a new record) is still correct:
    // ping the master only ONCE — without this guard, every follow-up
    // message the client sends about that project (still "different" from
    // this booked card, which never absorbs it)
    // would re-trigger the same hand-off and spam the master again.
    if (signals.is_new_project_request && card.second_project_flagged !== 'yes') {
      return 'new_project_after_booking';
    }

    if (signals.client_wants_to_reschedule) return 'reschedule_requested_ping_master';

    // v2: a generic photo is NOT proof of payment. Production always supplies
    // photo_purpose explicitly (possibly null/unknown). The absent-key branch
    // exists only for older internal callers/tests predating the v2 contract.
    if (
      card.lead_status === 'tattoo_booked_waiting_payment' &&
      card.has_photo_this_message &&
      card.payment_status !== 'waiting_confirmation' &&
      card.payment_status !== 'paid'
    ) {
      const hasPhotoPurposeSignal =
        Object.prototype.hasOwnProperty.call(signals, 'photo_purpose');
      if (!hasPhotoPurposeSignal) return 'payment_screenshot_received';
      if (signals.photo_purpose === 'payment_proof') return 'payment_screenshot_received';
      if (signals.photo_purpose === 'unknown' || signals.photo_purpose == null) {
        return 'clarify_booked_photo';
      }
    }
    return 'booked_followup_chat';
  }

  const isWaitingForSlots =
    card.lead_status === 'waiting_slots' || card.lead_status === 'waiting_slots_pinged';
  if (isWaitingForSlots) {
    if (hasSlots(card)) {
      return card.direct_tattoo_allowed === 'yes' ? 'show_tattoo_slots' : 'show_consultation_slots';
    }
    if (signals.client_wants_other_slots || signals.client_asks_for_more_slots) {
      return 'no_more_slots_waiting';
    }
    return 'waiting_slots_followup_chat';
  }

  // A photo with no caption needs one small clarification before diagnosis.
  if (card.has_photo_this_message && !card.photo_has_caption) return 'handle_photo_no_caption';

  // Slots already shown: interpret the client's choice before anything else.
  if (card.lead_status === 'slots_shown') {
    if (signals.client_picked_slot_id) {
      const isValidChoice = hasSlots(card) && card.slot_options!.includes(signals.client_picked_slot_id);
      if (!isValidChoice) return 'slot_taken_pick_again';
      return card.direct_tattoo_allowed === 'yes'
        ? 'confirm_slot_awaiting_payment'
        : 'confirm_consultation_booked';
    }
    if (signals.client_wants_other_slots) return 'slot_change_requested_waiting';
    if (signals.client_asks_for_more_slots) {
      if (hasSlots(card)) {
        return card.direct_tattoo_allowed === 'yes'
          ? 'show_tattoo_slots'
          : 'show_consultation_slots';
      }
      return 'no_more_slots_waiting';
    }
    return 'unclear_slot_choice';
  }

  // Diagnosis / pricing inputs.
  if (!card.idea) return 'ask_idea';
  if (!card.placement) return 'ask_placement';
  if (!card.size) return 'ask_size';
  if (!card.existing_tattoo) return 'ask_existing_tattoo_or_skin';

  const needsSkinDetail =
    (card.existing_tattoo === 'cover' ||
      card.existing_tattoo === 'modification' ||
      card.existing_tattoo === 'scar_work') &&
    !card.skin_notes;
  if (needsSkinDetail) return 'ask_skin_notes_detail';

  // Migration compatibility: old cards may have reference_asked=null even
  // though photos_count>0 already proves a reference/photo existed. Treat that
  // legacy null state as satisfied. A real NEW PROJECT sets reference_asked='no'
  // explicitly, so photos from an old project cannot suppress the new ask.
  const hasLegacyReference =
    card.reference_asked === null && card.photos_count > 0;
  if (card.reference_asked !== 'yes' && !hasLegacyReference) {
    return 'ask_reference_photo';
  }

  // Price must be shown, not merely calculated internally.
  const hasPrice = !!card.price_quoted || card.price_explained === 'yes';
  if (!hasPrice || card.price_shown !== 'yes') return 'quote_price';

  const effectiveWantsToBook =
    card.wants_to_book === 'yes'
      ? 'yes'
      : signals.client_confirms_booking ?? card.wants_to_book;

  if (effectiveWantsToBook === null) return 'ask_wants_to_book';
  if (effectiveWantsToBook === 'no') {
    return card.decline_followup_asked === 'yes' ? 'declined_followup_chat' : 'all_done';
  }

  // Direct tattoo route.
  if (card.direct_tattoo_allowed === 'yes') {
    if (!card.price_quoted) return 'quote_price';
    if (card.first_tattoo === null) return 'ask_first_tattoo';
    if (!card.phone) return 'ask_phone';
    if (!card.client_name) return 'ask_name';
    if (card.social_asked !== 'yes') return 'ask_social';
    return hasSlots(card) ? 'show_tattoo_slots' : 'no_more_slots_waiting';
  }

  // Consultation route.
  if (card.consultation_needed === 'yes') {
    if (!card.phone) return 'ask_phone';
    if (!card.client_name) return 'ask_name';
    if (!card.contact_channel) return 'ask_contact_channel';
    if (card.social_asked !== 'yes') return 'ask_social';
    return hasSlots(card) ? 'show_consultation_slots' : 'no_more_slots_waiting';
  }

  return 'quote_price';
}

export interface CardPatch {
  lead_status?: LeadStatus;
  spam_count?: 0 | 1 | 2 | 3;
  chosen_slot_id?: string | null;
  wants_to_book?: YesNo;
  slot_options?: string[] | null;
  payment_status?: PaymentStatus;
  social_asked?: YesNo;
  price_shown?: YesNo;
  decline_followup_asked?: YesNo;
  reference_asked?: YesNo;
  service_fit?: ServiceFit;
  second_project_flagged?: YesNo;
  campaign_collected?: Record<string, string> | null;
  campaign_handoff_sent?: YesNo;
}

export function getCardPatchForStep(
  step: NextStep,
  card: ClientCard,
  signals: MessageSignals
): CardPatch {
  // Campaign cards get a fully separate patch function — the tattoo-funnel
  // preamble below (wants_to_book / reference_asked bookkeeping) doesn't
  // apply and shouldn't touch a campaign card's fields.
  if (card.campaign_id) {
    return getCampaignCardPatch(step, card, signals);
  }

  const patch: CardPatch = {};

  if (signals.client_confirms_booking !== null && card.wants_to_book !== 'yes') {
    patch.wants_to_book = signals.client_confirms_booking;
  }

  // Persist service_fit only when the Extractor actually raised it this
  // message (including "allowed", which is how a prior lock gets cleared).
  // A null signal means the question didn't come up now — leave the card's
  // existing value untouched rather than overwriting it with null.
  if (signals.service_fit != null) {
    patch.service_fit = signals.service_fit;
  }

  // A real project/reference photo satisfies the per-project reference ask.
  // For no-caption photos, handle_photo_no_caption itself is the reference
  // clarification, so do not ask for another reference on the next turn.
  if (
    card.has_photo_this_message &&
    card.lead_status !== 'tattoo_booked_waiting_payment' &&
    card.lead_status !== 'consultation_booked'
  ) {
    patch.reference_asked = 'yes';
  }

  switch (step) {
    case 'all_done':
      return { ...patch, decline_followup_asked: 'yes' };
    case 'handle_out_of_scope_warning_1':
      return { ...patch, spam_count: 1 };
    case 'handle_out_of_scope_warning_2':
      return { ...patch, spam_count: 2 };
    case 'handle_out_of_scope_block':
      return { ...patch, spam_count: 3, lead_status: 'blocked' };
    case 'reschedule_requested_ping_master':
      return { ...patch, lead_status: 'waiting_slots_pinged' };
    case 'slot_change_requested_waiting':
    case 'no_more_slots_waiting':
      return { ...patch, chosen_slot_id: null, lead_status: 'waiting_slots' };
    case 'new_project_after_booking':
      return { ...patch, second_project_flagged: 'yes' };
    case 'ask_social':
      return { ...patch, social_asked: 'yes' };
    case 'ask_reference_photo':
      return { ...patch, reference_asked: 'yes' };
    case 'quote_price':
      return { ...patch, price_shown: 'yes' };
    case 'show_tattoo_slots':
    case 'show_consultation_slots':
      return { ...patch, lead_status: 'slots_shown' };
    case 'confirm_slot_awaiting_payment':
      return {
        ...patch,
        lead_status: 'tattoo_booked_waiting_payment',
        slot_options: null,
        payment_status: 'waiting_prepayment',
      };
    case 'confirm_consultation_booked':
      return { ...patch, lead_status: 'consultation_booked', slot_options: null };
    case 'payment_screenshot_received':
      return { ...patch, payment_status: 'waiting_confirmation' };
    default:
      return patch;
  }
}
