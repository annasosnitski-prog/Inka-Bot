// ============================================================
// INKA-BOT — общий вызов OpenAI Chat Completions.
// Extractor, Responder и Admin (диалог/портрет) раньше каждый повторяли
// один и тот же ~20-строчный блок (fetch, проверка res.ok, разбор JSON,
// проверка пустого ответа) — вынесено сюда, чтобы не дублировать. Сами
// промпты (system-контент) остаются в вызывающем коде и в .txt-файлах,
// этот файл только про механику HTTP-вызова.
// ============================================================

// Мультимодальный контент (текст + картинка) — используется только
// Extractor-ом для вижн-анализа референса (см. lib/extractor.ts).
// Responder и Admin продолжают работать с обычной строкой.
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatContentPart[];
}

export interface CallOpenAIChatOptions {
  model: string;
  temperature: number;
  messages: ChatMessage[];
  responseFormatJson?: boolean;
  label: string; // для сообщений об ошибке — какой вызывающий модуль (Extractor/Responder/Admin)
}

const RETRY_DELAYS_MS = [1000, 2000]; // паузы перед 2-й и 3-й попыткой — только на 5xx от OpenAI

export async function callOpenAIChat(opts: CallOpenAIChatOptions): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: opts.model,
        temperature: opts.temperature,
        ...(opts.responseFormatJson ? { response_format: { type: 'json_object' as const } } : {}),
        messages: opts.messages,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      lastError = new Error(`${opts.label} OpenAI call failed: ${response.status} ${errText}`);
      // Повторяем только серверные ошибки (5xx) — на них стоит переждать и попробовать
      // снова; 4xx (неверный ключ, лимиты, плохой запрос) повторять бессмысленно.
      if (response.status >= 500 && attempt < RETRY_DELAYS_MS.length) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        continue;
      }
      throw lastError;
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) {
      throw new Error(`${opts.label}: empty response from OpenAI`);
    }
    return text;
  }

  throw lastError ?? new Error(`${opts.label}: OpenAI call failed`);
}
