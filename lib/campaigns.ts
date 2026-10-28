// ============================================================
// INKA-BOT — Campaign configs
// Тип карточки одной рекламной/рекрутинговой кампании. Сами кампании
// живут в профиле мастера (lib/masters/<id>.ts, поле campaigns) —
// lib/campaignFlow.ts и промпты не знают их по имени, только по полям.
// ============================================================

import { getMasterProfile } from './masters';

export type CampaignPaymentType = 'consumables_only' | 'fixed' | 'range' | 'negotiable';

export interface CampaignPayment {
  type: CampaignPaymentType;
  // Точная сумма, если она реально известна и зафиксирована. null —
  // Responder НИКОГДА не придумывает число, использует только public_text.
  amount: string | null;
  public_text: string;
}

export interface CampaignConfig {
  id: string;
  type: 'model_recruitment' | string;
  title: string;
  goal: string;
  offer: string;
  master_experience?: string;
  payment: CampaignPayment;
  model_conditions: string[];
  // Generic field keys the campaign flow must collect before handoff.
  // Любые строки-идентификаторы — campaignFlow.ts не знает их смысла,
  // только то, что они должны быть заполнены.
  required_info: string[];
  optional_info: string[];
  // 'master_approval' — после сбора данных только хэндофф мастеру, сама
  //   кампания НЕ бронирует ничего в календаре (Аня решает и договаривается
  //   о времени сама, вне бота).
  // 'self_book_slot' — после сбора данных бот показывает и бронирует
  //   слот из ОТДЕЛЬНОГО пула [КАМПЕЙН] (lib/calendar.ts) — не из
  //   обычных ОКНО/ЧАТ клиентских пулов. Мастер создаёт эти слоты через
  //   /добавить кампейн ... (lib/addSlotParser.ts).
  booking_mode: 'master_approval' | 'self_book_slot';
  active: boolean;
}

export function getCampaign(id: string | null | undefined): CampaignConfig | null {
  if (!id) return null;
  // Кампании — часть профиля мастера: deep-link одного мастера не
  // активируется в боте другого.
  const found = getMasterProfile().campaigns.find((c) => c.id === id);
  return found && found.active ? found : null;
}
