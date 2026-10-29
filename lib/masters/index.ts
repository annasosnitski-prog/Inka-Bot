import type { MasterProfile } from './types';
import { anya } from './anya';
import { platon } from './platon';

export type { MasterProfile } from './types';

// Новый мастер = новый файл lib/masters/<id>.ts + папка lib/masters/<id>/
// с pricing.txt / scope.txt / value.txt (+ responder.txt, если есть особые
// правила речи) + строка здесь.
const PROFILES: Record<string, MasterProfile> = { anya, platon };

// MASTER_PROFILE выбирает мастера деплоя. PRICING_PROFILE — прежнее имя той
// же переменной, уже выставленное на деплое Платона.
export function getMasterProfile(): MasterProfile {
  const id = (process.env.MASTER_PROFILE ?? process.env.PRICING_PROFILE ?? '').trim().toLowerCase();
  if (!id) return anya;
  const profile = PROFILES[id];
  // Молча падать на Аню нельзя: так бот чужого мастера заговорит Аниными
  // ценами, ссылками и родом.
  if (!profile) throw new Error(`Unknown MASTER_PROFILE "${id}". Known: ${Object.keys(PROFILES).join(', ')}`);
  return profile;
}

export function getDepositAmount(): string {
  return getMasterProfile().depositAmount;
}

function masterLinks(p: MasterProfile): string {
  const lines: string[] = [];
  if (p.portfolioUrl) lines.push(`Портфолио: ${p.portfolioUrl}`);
  if (p.website) lines.push(`Сайт: ${p.website}`);
  if (lines.length === 0) {
    return 'Ссылок на портфолио или сайт мастера у тебя нет — не придумывай их. Если клиент просит посмотреть работы, скажи, что мастер пришлёт примеры сам.';
  }
  return lines.join('\n');
}

export function applyProfilePlaceholders(text: string, p: MasterProfile = getMasterProfile()): string {
  const isMale = p.gender === 'male';
  // Блоки профиля подставляются первыми: внутри них тоже бывают
  // {{MASTER_NAME}}/{{DEPOSIT}}, их заменят строки ниже.
  return text
    .replace(/\{\{CONSULTATION_DEPOSIT_NOTE\}\}/g, () => p.consultationDepositNote)
    .replace(/\{\{PRICING_RULES\}\}/g, () => p.pricingRules())
    .replace(/\{\{SERVICE_SCOPE\}\}/g, () => p.serviceScope())
    .replace(/\{\{MASTER_RULES\}\}/g, () => p.responderRules().trim() || 'Особых правил нет — действуют общие.')
    .replace(/\{\{MASTER_VALUE\}\}/g, () => p.valueContext())
    .replace(/\{\{TOTAL_ESTIMATE_LIMIT\}\}/g, String(p.totalEstimateDisclosureLimit))
    .replace(/\{\{MASTER_LINKS\}\}/g, () => masterLinks(p))
    .replace(/\{\{MASTER_NAME_GEN\}\}/g, p.nameGenitive)
    .replace(/\{\{MASTER_NAME\}\}/g, p.name)
    .replace(/\{\{MASTER_BUSY\}\}/g, isMale ? 'занят' : 'занята')
    .replace(/\{\{MASTER_SENT\}\}/g, isMale ? 'прислал' : 'прислала')
    .replace(/\{\{MASTER_PRONOUN\}\}/g, isMale ? 'он' : 'она')
    .replace(/\{\{MASTER_SELF\}\}/g, isMale ? 'сам' : 'сама')
    .replace(/\{\{DEPOSIT\}\}/g, p.depositAmount);
}
