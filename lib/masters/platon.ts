import fs from 'fs';
import path from 'path';
import type { MasterProfile } from './types';

const cache: Record<string, string> = {};

export const platon: MasterProfile = {
  id: 'platon',
  name: 'Платон',
  nameGenitive: 'Платона',
  gender: 'male',
  // Ссылки Платона пока не даны — без них бот не называет никаких ссылок.
  portfolioUrl: null,
  website: null,
  depositAmount: '400',
  consultationDepositNote:
    'Только предупреди: мастер работает по предоплате. Сумму, реквизиты и способ оплаты не называй и не обещай — бот предоплату не берёт, условия и оплату обсудит мастер на консультации.',
  consultationOnly: true,
  totalEstimateDisclosureLimit: 6000,
  campaigns: [],
  pricingRules: () =>
    (cache.pricing ??= fs.readFileSync(path.join(process.cwd(), 'lib', 'masters', 'platon', 'pricing.txt'), 'utf-8')),
  serviceScope: () =>
    (cache.scope ??= fs.readFileSync(path.join(process.cwd(), 'lib', 'masters', 'platon', 'scope.txt'), 'utf-8')),
  responderRules: () =>
    (cache.responder ??= fs.readFileSync(path.join(process.cwd(), 'lib', 'masters', 'platon', 'responder.txt'), 'utf-8')),
  valueContext: () =>
    (cache.value ??= fs.readFileSync(path.join(process.cwd(), 'lib', 'masters', 'platon', 'value.txt'), 'utf-8')),
};
