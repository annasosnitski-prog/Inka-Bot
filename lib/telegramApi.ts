// ============================================================
// INKA-BOT — тонкая обёртка над Telegram Bot API.
// Вынесена из pages/api/telegram.ts, чтобы переиспользовать в других
// эндпоинтах (например pages/api/payment-reminders.ts), не импортируя
// один API-роут из другого.
// ============================================================

// Общий вызов Telegram Bot API — раньше sendMessage/forwardMessage были
// продублированы (тут и в pages/api/telegram.ts) каждый со своим fetch
// и без проверки ответа: если Telegram отклонял вызов (сообщение длиннее
// 4096 символов, бот заблокирован, битый chat_id), это проходило
// незамеченным — ни ошибки, ни строки в логах. Теперь оба идут через
// один хелпер с проверкой res.ok.
async function callTelegramApi(method: string, body: Record<string, unknown>): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN not set');
    return false;
  }
  const url = `https://api.telegram.org/bot${token}/${method}`;
  // Временные сбои (сеть, 5xx, 429 с retry_after) переживаем повторами с
  // короткой паузой — мастеру важно получить пинг. Постоянные ошибки
  // (400/403: чужой chat_id, бот заблокирован) повторять бессмысленно.
  const delaysMs = [500, 1500, 3000];
  for (let attempt = 0; ; attempt++) {
    let retryAfterMs = 0;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) return true;
      const errText = await res.text().catch(() => '');
      console.error(`Telegram ${method} failed: ${res.status} ${errText}`);
      const transient = res.status === 429 || res.status >= 500;
      if (!transient) return false;
      const m = /"retry_after"\s*:\s*(\d+)/.exec(errText);
      if (m) retryAfterMs = Number(m[1]) * 1000;
    } catch (err) {
      console.error(`Telegram ${method} network error:`, err);
    }
    if (attempt >= delaysMs.length) return false;
    await new Promise((r) => setTimeout(r, Math.min(Math.max(delaysMs[attempt], retryAfterMs), 4000)));
  }
}

// Возвращает true, только если Telegram принял сообщение.
export async function sendTelegramMessage(chatId: number, text: string): Promise<boolean> {
  return callTelegramApi('sendMessage', { chat_id: chatId, text });
}

// Сообщение с HTML-разметкой (кликабельные ссылки). Текст должен быть
// заранее экранирован через escapeHtml.
export async function sendTelegramHtml(chatId: number, html: string): Promise<boolean> {
  return callTelegramApi('sendMessage', {
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Ссылки «написать клиенту одним тапом»: поиск по Telegram-id с телефона
// невозможен, поэтому мастеру даём готовые ссылки. tg://user?id работает
// и без username (бот уже общался с клиентом); WhatsApp — по номеру.
export function clientContactLinks(telegramId: number, username: string, phone: string): string {
  const links: string[] = [];
  if (username) links.push(`<a href="https://t.me/${escapeHtml(username)}">Telegram @${escapeHtml(username)}</a>`);
  links.push(`<a href="tg://user?id=${telegramId}">Telegram (по id)</a>`);
  const digits = phone.replace(/\D/g, '');
  if (digits.length >= 9) {
    const intl = digits.startsWith('0') ? `972${digits.slice(1)}` : digits;
    links.push(`<a href="https://wa.me/${intl}">WhatsApp ${escapeHtml(phone)}</a>`);
  }
  return links.join(' · ');
}

export async function forwardTelegramMessage(
  toChatId: number,
  fromChatId: number,
  messageId: number
): Promise<void> {
  await callTelegramApi('forwardMessage', {
    chat_id: toChatId,
    from_chat_id: fromChatId,
    message_id: messageId,
  });
}

// ----------------------------------------------------------
// ВИЖН — скачивание фото для передачи в OpenAI (см. lib/extractor.ts).
// Telegram присылает одно и то же фото несколькими размерами (массив
// от меньшего к большему) — берём самый большой.
// ----------------------------------------------------------

export interface TelegramPhotoSize {
  file_id: string;
  width?: number;
  height?: number;
  file_size?: number;
}

// Целевая ширина для вижн-вызовов (Extractor/Admin): им нужно различить
// "чистая кожа / тату / шрам" и прочитать референс, не разглядеть пиксели
// — а OpenAI считает токены по размеру картинки. Самый большой размер от
// Telegram (иногда 1280px+) стоит заметно дороже без выигрыша в качестве
// этих проверок, поэтому берём средний размер из присланного Telegram
// набора, а не последний (самый большой).
const VISION_TARGET_WIDTH = 1024;

// Чистая функция (без сети) — вынесена отдельно, чтобы её можно было
// протестировать без реального Telegram API. Если Telegram не прислал
// width (бывает у старых клиентов) — падаем назад на "взять последний",
// как раньше, а не угадываем размер.
export function pickVisionTelegramPhoto(
  sizes: TelegramPhotoSize[] | undefined
): TelegramPhotoSize | null {
  if (!sizes || sizes.length === 0) return null;
  const withWidth = sizes.filter((s): s is TelegramPhotoSize & { width: number } =>
    typeof s.width === 'number'
  );
  if (withWidth.length === 0) return sizes[sizes.length - 1];
  const sorted = [...withWidth].sort((a, b) => a.width - b.width);
  return sorted.find((s) => s.width >= VISION_TARGET_WIDTH) ?? sorted[sorted.length - 1];
}

// Скачивает файл по file_id и возвращает его как data URL
// (data:image/jpeg;base64,...), готовый для image_url в вызове OpenAI.
// Фото из Telegram — всегда JPEG. Возвращает null при любой ошибке
// (нет токена, файл не найден, сеть упала) — вызывающий код (Extractor)
// в этом случае просто не прикладывает картинку и работает как раньше,
// на одном тексте.
export async function getTelegramFileDataUrl(fileId: string): Promise<string | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN not set');
    return null;
  }

  try {
    const fileInfoRes = await fetch(
      `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`
    );
    if (!fileInfoRes.ok) {
      console.error(`Telegram getFile failed: ${fileInfoRes.status} ${await fileInfoRes.text()}`);
      return null;
    }
    const fileInfo = await fileInfoRes.json();
    const filePath: string | undefined = fileInfo?.result?.file_path;
    if (!filePath) return null;

    const fileRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
    if (!fileRes.ok) {
      console.error(`Telegram file download failed: ${fileRes.status}`);
      return null;
    }
    const buffer = Buffer.from(await fileRes.arrayBuffer());
    return `data:image/jpeg;base64,${buffer.toString('base64')}`;
  } catch (err) {
    console.error('getTelegramFileDataUrl failed:', err);
    return null;
  }
}
