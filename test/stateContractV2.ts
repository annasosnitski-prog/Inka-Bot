import {
  getNextStep,
  getCardPatchForStep,
  type ClientCard,
  type MessageSignals,
} from '../lib/stateMachine';
import { mergeClientCard } from '../lib/clientCardMerge';
import type { ExtractorOutput } from '../lib/extractor';

let passed = 0;
let failed = 0;

function eq(name: string, got: unknown, expected: unknown) {
  if (got === expected) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name} — got '${String(got)}', expected '${String(expected)}'`);
  }
}

function card(over: Partial<ClientCard> = {}): ClientCard {
  return {
    telegram_id: 1,
    intent: 'booking',
    lead_status: 'estimated',
    category: 'small',
    idea: 'роза',
    size: '10 см',
    placement: 'предплечье',
    first_tattoo: 'no',
    existing_tattoo: 'no',
    direct_tattoo_allowed: 'yes',
    consultation_needed: 'no',
    active_work_time_estimate: '<=3h',
    price_quoted: '800₪',
    price_explained: null,
    price_factors: null,
    price_shown: 'yes',
    wants_to_book: 'yes',
    decline_followup_asked: null,
    phone: '0501112233',
    client_name: 'Маша',
    contact_channel: 'telegram',
    social_link: null,
    social_asked: 'yes',
    payment_status: null,
    client_type: null,
    skin_notes: null,
    spam_count: 0,
    chosen_slot_id: null,
    slot_options: ['ev1'],
    booked_slot_display: null,
    booked_slot_start_iso: null,
    payment_reminder_sent: null,
    booked_at: null,
    payment_reminder_early_sent: null,
    reference_asked: 'yes',
    photos_count: 0,
    has_photo_this_message: false,
    photo_has_caption: false,
    force_client_mode: null,
    ...over,
  };
}

function signals(over: Partial<MessageSignals> = {}): MessageSignals {
  return {
    is_admin_sender: false,
    is_prompt_injection: false,
    is_out_of_scope: false,
    is_wrong_layout: false,
    client_picked_slot_id: null,
    client_wants_other_slots: false,
    client_asks_for_more_slots: false,
    client_wants_to_reschedule: false,
    client_confirms_booking: null,
    service_fit: null,
    service_fit_reason: null,
    is_new_project_request: false,
    photo_purpose: null,
    ...over,
  };
}

function extracted(over: Partial<ExtractorOutput> = {}): ExtractorOutput {
  return {
    intent: 'idea',
    idea: 'роза',
    placement: 'предплечье',
    size: '10 см',
    existing_tattoo: 'no',
    skin_notes: null,
    first_tattoo: 'no',
    category: 'small',
    active_work_time_estimate: '<=3h',
    direct_tattoo_allowed: 'yes',
    consultation_needed: 'no',
    price_quoted: '800₪',
    price_explained: null,
    price_factors: null,
    phone: '0501112233',
    client_name: 'Маша',
    contact_channel: 'telegram',
    social_link: null,
    is_prompt_injection: false,
    is_out_of_scope: false,
    is_wrong_layout: false,
    has_photo_this_message: false,
    photo_has_caption: false,
    client_picked_slot_id: null,
    client_wants_other_slots: false,
    client_asks_for_more_slots: false,
    client_wants_to_reschedule: false,
    client_confirms_booking: null,
    service_fit: null,
    service_fit_reason: null,
    is_new_project_request: false,
    photo_purpose: null,
    ...over,
  };
}

console.log('\n▶ v2 service-fit gate');
eq(
  'unsupported service never reaches quote/booking',
  getNextStep(card(), signals({ service_fit: 'not_offered' })),
  'handle_service_not_offered'
);
eq(
  'ambiguous style is clarified before funnel continues',
  getNextStep(card(), signals({ service_fit: 'needs_clarification' })),
  'clarify_service_fit'
);

console.log('\n▶ v2 booked-photo classification');
const bookedPhoto = card({
  lead_status: 'tattoo_booked_waiting_payment',
  payment_status: 'waiting_prepayment',
  has_photo_this_message: true,
  slot_options: null,
});
eq(
  'real payment proof enters confirmation flow',
  getNextStep(bookedPhoto, signals({ photo_purpose: 'payment_proof' })),
  'payment_screenshot_received'
);
eq(
  'tattoo reference is NOT treated as payment proof',
  getNextStep(bookedPhoto, signals({ photo_purpose: 'reference' })),
  'booked_followup_chat'
);
eq(
  'unclassified booked photo asks what it is',
  getNextStep(bookedPhoto, signals({ photo_purpose: 'unknown' })),
  'clarify_booked_photo'
);
const paymentPatch = getCardPatchForStep(
  'payment_screenshot_received',
  bookedPhoto,
  signals({ photo_purpose: 'payment_proof' })
);
eq('payment proof patch waits for master confirmation', paymentPatch.payment_status, 'waiting_confirmation');

console.log('\n▶ v2 new-project merge');
const oldProject = card({
  idea: 'старый скорпион',
  placement: 'щиколотка',
  size: '8 см',
  price_quoted: '900₪',
  price_shown: 'yes',
  reference_asked: 'yes',
  first_tattoo: 'no',
  phone: '0501112233',
  client_name: 'Маша',
});
const newProject = mergeClientCard(
  oldProject,
  extracted({
    is_new_project_request: true,
    idea: 'новая абстракция',
    placement: 'спина',
    size: null,
    existing_tattoo: null,
    category: null,
    active_work_time_estimate: null,
    direct_tattoo_allowed: null,
    consultation_needed: null,
    price_quoted: null,
    price_explained: null,
    price_factors: null,
    first_tattoo: null,
  }),
  { hasPhotoThisMessage: false, photoHasCaption: false }
);
eq('new project replaces idea', newProject.idea, 'новая абстракция');
eq('new project replaces placement', newProject.placement, 'спина');
eq('new project really clears old size', newProject.size, null);
eq('new project really clears old price', newProject.price_quoted, null);
eq('new project resets price_shown', newProject.price_shown, null);
eq('new project marks reference as not yet asked for this project', newProject.reference_asked, 'no');
eq('first_tattoo survives project change', newProject.first_tattoo, 'no');
eq('phone survives project change', newProject.phone, '0501112233');
eq('client name survives project change', newProject.client_name, 'Маша');

console.log('\n▶ v2 booked-project isolation');
const booked = card({
  lead_status: 'tattoo_booked_waiting_payment',
  idea: 'забронированная роза',
  placement: 'предплечье',
  payment_status: 'waiting_prepayment',
  slot_options: null,
});
const protectedBooked = mergeClientCard(
  booked,
  extracted({
    is_new_project_request: true,
    idea: 'совсем другая тату',
    placement: 'спина',
    price_quoted: null,
  }),
  { hasPhotoThisMessage: false, photoHasCaption: false }
);
eq('second project does not overwrite booked idea', protectedBooked.idea, 'забронированная роза');
eq('second project does not overwrite booked placement', protectedBooked.placement, 'предплечье');
eq(
  'second project after booking routes to handoff',
  getNextStep(protectedBooked, signals({ is_new_project_request: true })),
  'new_project_after_booking'
);

console.log('\n▶ v2 price contract');
eq(
  'direct tattoo cannot proceed with explained-only price',
  getNextStep(
    card({ price_quoted: null, price_explained: 'yes', direct_tattoo_allowed: 'yes' }),
    signals()
  ),
  'quote_price'
);
eq(
  'consultation project may proceed after price was explained without fake exact quote',
  getNextStep(
    card({
      category: 'project',
      price_quoted: null,
      price_explained: 'yes',
      direct_tattoo_allowed: 'no',
      consultation_needed: 'yes',
      contact_channel: 'telegram',
    }),
    signals()
  ),
  'show_consultation_slots'
);

console.log(`\nV2 STATE CONTRACT: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
