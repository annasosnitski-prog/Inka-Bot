// ============================================================
// INKA-BOT — Campaign flow
// Generic, config-driven state machine for campaign/recruitment leads
// (see lib/campaigns.ts). Deliberately separate from the normal client
// funnel (lib/stateMachine.ts core logic, pricingRules) — no campaign
// name or copy lives here, only the mechanics of "ask required_info in
// order, ask optional_info once, then hand off".
// ============================================================

import type { ClientCard, MessageSignals, NextStep, CardPatch, YesNo, LeadStatus } from './stateMachine';
import { getCampaign, type CampaignConfig } from './campaigns';

const INTRO_SENT_KEY = '__intro_sent';

export interface CampaignRouting {
  step: NextStep;
  pendingField: string | null;
  campaign: CampaignConfig;
}

// Pure, config-driven routing. Returns null when card.campaign_id does not
// resolve to a known/active campaign (unknown id, or deactivated mid-flight)
// — the caller falls back to the normal funnel in that case, never to a
// half-built campaign state.
// Activates a campaign on a card, fully replacing any previous campaign
// state. Used both for a fresh /start <campaign_id> and for switching from
// one active campaign to another mid-conversation — either way the old
// collected answers must not leak into the new campaign's data set.
export function activateCampaign(card: ClientCard, campaignId: string): ClientCard {
  return {
    ...card,
    campaign_id: campaignId,
    campaign_collected: {},
    campaign_handoff_sent: null,
  };
}

// `signals` is optional because the caller in pages/api/telegram.ts needs
// a routing result (for campaign/pendingField) BEFORE running the
// Extractor, when no real MessageSignals exist yet — at that point the
// slot-picking branch below simply can't have a pick to consider, which is
// correct: pendingField during the collection phase never depends on it.
export function routeCampaign(card: ClientCard, signals?: MessageSignals | null): CampaignRouting | null {
  const campaign = getCampaign(card.campaign_id);
  if (!campaign) return null;

  if (card.campaign_handoff_sent === 'yes') {
    return { step: 'campaign_followup_chat', pendingField: null, campaign };
  }

  const collected = card.campaign_collected ?? {};
  const introSent = collected[INTRO_SENT_KEY] === '1';

  const nextRequired = campaign.required_info.find((f) => !collected[f]);
  if (nextRequired) {
    return {
      step: introSent ? 'campaign_ask_field' : 'campaign_intro',
      pendingField: nextRequired,
      campaign,
    };
  }

  // Optional fields are asked at most once each — "asked" is recorded as
  // soon as the question is sent (see getCampaignCardPatch), regardless of
  // whether the client ever answers, so this never loops forever on a
  // field that is by definition not required.
  const nextOptional = campaign.optional_info.find((f) => collected[f] === undefined);
  if (nextOptional) {
    return { step: 'campaign_ask_field', pendingField: nextOptional, campaign };
  }

  // All info collected — what happens next depends on booking_mode.
  if (campaign.booking_mode === 'self_book_slot') {
    // card.slot_options/chosen_slot_id are the SAME generic ClientCard
    // fields the normal tattoo/consultation funnel uses — reused here
    // rather than adding campaign-only duplicates, since a campaign card
    // never runs that funnel (direct_tattoo_allowed/consultation_needed
    // stay null) so these fields are otherwise idle on it.
    if (card.chosen_slot_id) {
      return { step: 'campaign_confirm_slot', pendingField: null, campaign };
    }
    const slotsAvailable = !!card.slot_options && card.slot_options.length > 0;
    if (
      slotsAvailable &&
      signals?.client_picked_slot_id &&
      card.slot_options!.includes(signals.client_picked_slot_id)
    ) {
      return { step: 'campaign_confirm_slot', pendingField: null, campaign };
    }
    return {
      step: slotsAvailable ? 'campaign_show_slots' : 'campaign_no_slots',
      pendingField: null,
      campaign,
    };
  }

  return { step: 'campaign_handoff', pendingField: null, campaign };
}

export function getCampaignCardPatch(
  step: NextStep,
  card: ClientCard,
  _signals: MessageSignals
): CardPatch {
  const campaign = getCampaign(card.campaign_id);
  if (!campaign) return {};

  const collected = { ...(card.campaign_collected ?? {}) };

  switch (step) {
    case 'campaign_intro':
      collected[INTRO_SENT_KEY] = '1';
      return { campaign_collected: collected };
    case 'campaign_handoff':
      return { campaign_collected: collected, campaign_handoff_sent: 'yes' as YesNo };
    case 'campaign_show_slots':
      // Reuses lead_status='slots_shown' purely so the EXISTING Extractor
      // rule ("client_picked_slot_id only when lead_status=slots_shown AND
      // slot_options not empty") fires for campaign cards too — campaign
      // routing itself never reads lead_status. See extractorPrompt.txt.
      return { campaign_collected: collected, lead_status: 'slots_shown' as LeadStatus };
    case 'campaign_no_slots':
      // One-time marker so pages/api/telegram.ts pings the master about
      // demand only once, not on every message while the pool is empty.
      collected['__no_slots_pinged'] = '1';
      return { campaign_collected: collected };
    case 'campaign_confirm_slot':
      // Booking already happened in pages/api/telegram.ts (bookSlot) by the
      // time this patch runs; here we just close out the campaign funnel
      // and free slot_options the same way confirm_slot_awaiting_payment
      // does for the normal tattoo flow.
      return { campaign_collected: collected, campaign_handoff_sent: 'yes' as YesNo, slot_options: null };
    default:
      // campaign_ask_field / campaign_followup_chat: nothing extra to
      // record beyond passing through the (already merged by the caller)
      // collected map.
      return { campaign_collected: collected };
  }
}

// Called by pages/api/telegram.ts right after the Extractor runs, to fold
// this turn's answer (if any) into the persisted collected map. `field` is
// the pendingField that was active BEFORE this message (i.e. what the
// client's message is presumed to answer).
export function applyCampaignAnswer(
  card: ClientCard,
  field: string | null,
  answer: string | null
): ClientCard {
  if (!field) return card;
  const campaign = getCampaign(card.campaign_id);
  if (!campaign) return card;

  const collected = { ...(card.campaign_collected ?? {}) };
  if (answer) {
    collected[field] = answer;
  } else if (campaign.optional_info.includes(field) && collected[field] === undefined) {
    // Optional field, asked, no answer this turn — resolve it anyway so we
    // never ask it twice.
    collected[field] = '';
  }
  return { ...card, campaign_collected: collected };
}

// ----------------------------------------------------------
// Airtable <-> ClientCard serialization for the campaign-only fields.
// Mirrors the dialog_history pattern (lib/dialogLog.ts): one JSON blob in
// a single Long text column, so campaign_id survives a serverless restart
// without needing a bespoke Airtable field per campaign.
// ----------------------------------------------------------

export function parseCampaignData(raw: unknown): {
  collected: Record<string, string> | null;
  handoff_sent: YesNo;
} {
  if (!raw || typeof raw !== 'string') return { collected: null, handoff_sent: null };
  try {
    const parsed = JSON.parse(raw);
    const collected =
      parsed && typeof parsed.collected === 'object' && parsed.collected !== null
        ? parsed.collected
        : null;
    const handoff_sent: YesNo = parsed?.handoff_sent === true || parsed?.handoff_sent === 'yes' ? 'yes' : null;
    return { collected, handoff_sent };
  } catch (err) {
    console.error('parseCampaignData failed (non-fatal, treated as no campaign data):', err);
    return { collected: null, handoff_sent: null };
  }
}

export function serializeCampaignData(card: ClientCard): string {
  return JSON.stringify({
    collected: card.campaign_collected ?? {},
    handoff_sent: card.campaign_handoff_sent === 'yes',
  });
}

// ----------------------------------------------------------
// Master notifications.
// ----------------------------------------------------------

function campaignFieldSummaryLines(
  campaign: CampaignConfig,
  collected: Record<string, string>
): string[] {
  const allFields = [...campaign.required_info, ...campaign.optional_info];
  return allFields
    .map((field) => {
      const value = collected[field];
      if (value === undefined) return null;
      return `• ${field}: ${value || '—'}`;
    })
    .filter((l): l is string => l !== null);
}

// booking_mode: master_approval — Аня decides, nothing is booked yet.
export function buildCampaignHandoffNotification(
  campaign: CampaignConfig,
  collected: Record<string, string>,
  clientLabel: string,
  username: string
): string {
  const who = username ? `${clientLabel} (@${username})` : clientLabel;
  const lines = campaignFieldSummaryLines(campaign, collected);
  return [
    `🧪 Кандидат по кампании «${campaign.title}» — ${who}.`,
    `Нужна оценка: подходит ли зона/идея для этого проекта.`,
    ...lines,
  ].join('\n');
}

// booking_mode: self_book_slot — a real [КАМПЕЙН] calendar slot is already
// booked by the time this fires; Аня just needs to know who/when/what.
export function buildCampaignSlotBookedNotification(
  campaign: CampaignConfig,
  collected: Record<string, string>,
  clientLabel: string,
  username: string,
  whenDisplay: string
): string {
  const who = username ? `${clientLabel} (@${username})` : clientLabel;
  const lines = campaignFieldSummaryLines(campaign, collected);
  return [
    `🧪 Новая запись по кампании «${campaign.title}» — ${who}.`,
    `Забронировано: ${whenDisplay}.`,
    ...lines,
  ].join('\n');
}

// booking_mode: self_book_slot, pool empty — one-time demand ping so Аня
// knows to open a [КАМПЕЙН] slot; see getCampaignCardPatch's
// '__no_slots_pinged' guard for why this fires only once per client.
export function buildCampaignNoSlotsNotification(
  campaign: CampaignConfig,
  clientLabel: string,
  username: string
): string {
  const who = username ? `${clientLabel} (@${username})` : clientLabel;
  return (
    `🧪 По кампании «${campaign.title}» сейчас нет открытых слотов [КАМПЕЙН], а ${who} уже готов(а) записаться. ` +
    `Добавь слот через /добавить кампейн ... — бот предложит его сам.`
  );
}
