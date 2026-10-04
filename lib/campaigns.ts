// ============================================================
// INKA-BOT — Campaign configs
// Каждая запись — самостоятельная карточка данных для одной
// рекламной/рекрутинговой кампании. Новая кампания добавляется сюда
// изменением конфига — lib/campaignFlow.ts и промпты её не знают
// по имени, только по этим полям.
// ============================================================

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

const CAMPAIGNS: CampaignConfig[] = [
  {
    id: 'color_texture',
    type: 'model_recruitment',
    title: 'Модель — цветные текстуры',
    goal: 'Найти моделей для отработки цветных текстур',
    offer: 'Татуировка с цветными текстурами в направлении примеров из объявления',
    master_experience: 'около 4 лет',
    payment: {
      type: 'consumables_only',
      amount: null,
      public_text: 'Оплата только за расходники / открытие иглы',
    },
    model_conditions: [
      'Мастер получает больше творческой свободы, чем при обычном клиентском заказе',
      'Итоговая работа строится в направлении примеров кампании, а не является копированием конкретного референса',
    ],
    required_info: ['placement', 'approximate_size'],
    optional_info: ['photo_of_placement'],
    booking_mode: 'self_book_slot',
    active: true,
  },
];

export function getCampaign(id: string | null | undefined): CampaignConfig | null {
  if (!id) return null;
  const found = CAMPAIGNS.find((c) => c.id === id);
  return found && found.active ? found : null;
}
