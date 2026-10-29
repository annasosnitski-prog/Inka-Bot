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
  portfolioUrl: 'https://www.instagram.com/platon_tattoo__/',
  website: null,
  depositAmount: '400',
  consultationDepositNote:
    'Предупреди: если на консультации договоритесь о встрече (сеансе), понадобится предоплата {{DEPOSIT}}₪. Реквизиты и оплату не обещай: бот предоплату не берёт, мастер {{MASTER_SELF}} свяжется с клиентом, подтвердит запись и объяснит оплату.',
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
