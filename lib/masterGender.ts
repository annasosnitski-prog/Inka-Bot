// ============================================================
// Общая логика рода мастера (имя/пол) для деплоя с мастером, отличным
// от Ани по умолчанию. Используется во всех промптах, где встречаются
// глаголы/местоимения, согласованные с полом мастера. Один источник
// правды вместо дублирования в admin.ts/extractor.ts/responder.ts.
// ============================================================

export function getMasterName(): string {
  return (process.env.MASTER_NAME ?? '').trim() || 'Аня';
}

export function getMasterGender(): 'female' | 'male' {
  return (process.env.MASTER_GENDER ?? '').trim().toLowerCase() === 'male'
    ? 'male'
    : 'female';
}

// Родительный падеж имени ("ассистентка тату-мастера Ани/Платона") нельзя
// вывести автоматически из любого имени — для нового деплоя задаётся
// явно через MASTER_NAME_GENITIVE. Если не задано, используем само имя
// как грубое приближение.
export function getMasterNameGenitive(): string {
  return (process.env.MASTER_NAME_GENITIVE ?? '').trim() || getMasterName();
}

// Портфолио/сайт мастера — по умолчанию Анины (совместимость с
// деплоем, где эти env var ещё не заданы), для другого деплоя
// задаются явно через MASTER_PORTFOLIO_URL/MASTER_WEBSITE.
export function getMasterPortfolioUrl(): string {
  return (process.env.MASTER_PORTFOLIO_URL ?? '').trim() || 'https://www.instagram.com/ink_anya';
}

export function getMasterWebsite(): string {
  return (process.env.MASTER_WEBSITE ?? '').trim() || 'inkanya.co.il';
}

// Заменяет {{MASTER_NAME}} и все согласованные с полом мастера
// плейсхолдеры в тексте промпта.
export function applyMasterGenderPlaceholders(text: string): string {
  const isMale = getMasterGender() === 'male';
  return text
    .replace(/\{\{MASTER_NAME\}\}/g, getMasterName())
    .replace(/\{\{MASTER_NAME_GEN\}\}/g, getMasterNameGenitive())
    .replace(/\{\{MASTER_BUSY\}\}/g, isMale ? 'занят' : 'занята')
    .replace(/\{\{MASTER_SENT\}\}/g, isMale ? 'прислал' : 'прислала')
    .replace(/\{\{MASTER_PRONOUN\}\}/g, isMale ? 'он' : 'она')
    .replace(/\{\{MASTER_SELF\}\}/g, isMale ? 'сам' : 'сама')
    .replace(/\{\{MASTER_PORTFOLIO\}\}/g, getMasterPortfolioUrl())
    .replace(/\{\{MASTER_WEBSITE\}\}/g, getMasterWebsite());
}
