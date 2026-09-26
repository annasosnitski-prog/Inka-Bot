import type { ClientCard } from './stateMachine';
import type { ExtractorOutput } from './extractor';

export interface MessageFlags {
  hasPhotoThisMessage: boolean;
  photoHasCaption: boolean;
}

export function isBooked(card: ClientCard): boolean {
  return (
    card.lead_status === 'tattoo_booked_waiting_payment' ||
    card.lead_status === 'consultation_booked'
  );
}

/**
 * Merge Extractor facts into the persistent client card.
 *
 * Two rules matter here:
 * 1) null from Extractor is normally "no new fact", so the old value stays;
 * 2) on an explicit NEW PROJECT, project-scoped fields must really reset.
 *
 * A second project mentioned while another project is already booked is NOT
 * merged into the booked card at all. State machine routes it to a hand-off.
 */
export function mergeClientCard(
  current: ClientCard,
  extracted: ExtractorOutput,
  messageFlags: MessageFlags
): ClientCard {
  const messageState = {
    has_photo_this_message: messageFlags.hasPhotoThisMessage,
    photo_has_caption: messageFlags.photoHasCaption,
  };

  if (extracted.is_new_project_request && isBooked(current)) {
    return {
      ...current,
      ...messageState,
      // Intent can describe the current message without corrupting the booked
      // project's tattoo fields.
      intent: extracted.intent ?? current.intent,
    };
  }

  if (extracted.is_new_project_request) {
    return {
      ...current,
      ...messageState,
      intent: extracted.intent ?? 'idea',
      lead_status: 'diagnosing',

      // New project facts: take only what Extractor actually knows now.
      idea: extracted.idea,
      placement: extracted.placement,
      size: extracted.size,
      existing_tattoo: extracted.existing_tattoo,
      skin_notes: extracted.skin_notes,
      category: extracted.category,
      active_work_time_estimate: extracted.active_work_time_estimate,
      direct_tattoo_allowed: extracted.direct_tattoo_allowed,
      consultation_needed: extracted.consultation_needed,
      price_quoted: extracted.price_quoted,
      price_explained: extracted.price_explained,
      price_factors: extracted.price_factors,

      // Project/funnel state must not leak from the previous tattoo.
      price_shown: null,
      wants_to_book: null,
      decline_followup_asked: null,
      chosen_slot_id: null,
      slot_options: null,
      payment_status: null,
      booked_slot_display: null,
      booked_slot_start_iso: null,
      payment_reminder_sent: null,
      booked_at: null,
      payment_reminder_early_sent: null,
      // Explicit "no" means: for THIS new project a reference has not yet
      // been asked/supplied. This distinguishes it from legacy cards where
      // reference_asked=null but photos_count>0 already proves an old photo.
      reference_asked: 'no',
      // service_fit is a per-project gate — a lock from the previous project
      // must not silently carry over onto an unrelated new one.
      service_fit: null,
      // A fresh project has nothing pinged about it yet.
      second_project_flagged: null,

      // Person-scoped fields survive a project change.
      first_tattoo: extracted.first_tattoo ?? current.first_tattoo,
      phone: extracted.phone ?? current.phone,
      client_name: extracted.client_name ?? current.client_name,
      contact_channel: extracted.contact_channel ?? current.contact_channel,
      social_link: extracted.social_link ?? current.social_link,
    };
  }

  return {
    ...current,
    ...messageState,
    intent: extracted.intent ?? current.intent,
    idea: extracted.idea ?? current.idea,
    placement: extracted.placement ?? current.placement,
    size: extracted.size ?? current.size,
    existing_tattoo: extracted.existing_tattoo ?? current.existing_tattoo,
    skin_notes: extracted.skin_notes ?? current.skin_notes,
    first_tattoo: extracted.first_tattoo ?? current.first_tattoo,
    category: extracted.category ?? current.category,
    active_work_time_estimate:
      extracted.active_work_time_estimate ?? current.active_work_time_estimate,
    direct_tattoo_allowed:
      extracted.direct_tattoo_allowed ?? current.direct_tattoo_allowed,
    consultation_needed:
      extracted.consultation_needed ?? current.consultation_needed,
    price_quoted: extracted.price_quoted ?? current.price_quoted,
    price_explained: extracted.price_explained ?? current.price_explained,
    price_factors: extracted.price_factors ?? current.price_factors,
    phone: extracted.phone ?? current.phone,
    client_name: extracted.client_name ?? current.client_name,
    contact_channel: extracted.contact_channel ?? current.contact_channel,
    social_link: extracted.social_link ?? current.social_link,
  };
}
