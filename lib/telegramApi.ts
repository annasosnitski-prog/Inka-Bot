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
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(`Telegram ${method} failed: ${res.status} ${errText}`);
    return false;
  }
  return true;
}

export async function sendTelegramMessage(chatId: number, text: string): Promise<void> {
  await callTelegramApi('sendMessage', { chat_id: chatId, text });
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

// Чистая функция (без сети) — вынесена отдельно, чтобы её можно было
// протестировать без реального Telegram API.
export function pickLargestTelegramPhoto(
  sizes: TelegramPhotoSize[] | undefined
): TelegramPhotoSize | null {
  if (!sizes || sizes.length === 0) return null;
  return sizes[sizes.length - 1];
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
