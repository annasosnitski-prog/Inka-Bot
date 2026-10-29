import fs from 'fs';
import path from 'path';
import type { MasterProfile } from './types';

const cache: Record<string, string> = {};

export const anya: MasterProfile = {
  id: 'anya',
  name: 'Аня',
  nameGenitive: 'Ани',
  gender: 'female',
  portfolioUrl: 'https://www.instagram.com/ink_anya',
  website: 'inkanya.co.il',
  depositAmount: '200',
  consultationDepositNote:
    'Сразу назови предоплату: если по итогам консультации решишь записываться — нужна предоплата {{DEPOSIT}}₪ (входит в общую стоимость).',
  consultationMode: 'chat',
  tattooBooking: 'bot',
  totalEstimateDisclosureLimit: 2500,
  campaigns: [
    {
      id: 'color_texture',
      type: 'model_recruitment',
      title: 'Модель — цветные текстуры',
      goal: 'Найти моделей для отработки цветных текстур',
      offer:
        'Татуировка с цветными текстурами в направлении примеров из объявления — небольшая работа, не больше 3 см',
      master_experience: 'около 4 лет',
      payment: {
        type: 'consumables_only',
        // Сумма известна, но Responder называет её ТОЛЬКО когда человек сам
        // явно спрашивает точную цифру (см. lib/prompts/campaignResponder.txt).
        amount: '400₪',
        public_text: 'Оплата только за расходники / открытие иглы',
      },
      model_conditions: [
        'Мастер получает больше творческой свободы, чем при обычном клиентском заказе',
        'Итоговая работа строится в направлении примеров кампании, а не является копированием конкретного референса',
      ],
      // preferred_contact — канал (телега/вотсап), не номер телефона.
      required_info: ['placement', 'photo_of_placement', 'preferred_contact'],
      optional_info: [],
      booking_mode: 'self_book_slot',
      active: true,
    },
  ],
  pricingRules: () =>
    (cache.pricing ??= fs.readFileSync(path.join(process.cwd(), 'lib', 'masters', 'anya', 'pricing.txt'), 'utf-8')),
  serviceScope: () =>
    (cache.scope ??= fs.readFileSync(path.join(process.cwd(), 'lib', 'masters', 'anya', 'scope.txt'), 'utf-8')),
  responderRules: () => '',
  valueContext: () =>
    (cache.value ??= fs.readFileSync(path.join(process.cwd(), 'lib', 'masters', 'anya', 'value.txt'), 'utf-8')),
};
