// ============================================================
// INKA-BOT — общий вызов OpenAI Chat Completions.
// Extractor, Responder и Admin (диалог/портрет) раньше каждый повторяли
// один и тот же ~20-строчный блок (fetch, проверка res.ok, разбор JSON,
// проверка пустого ответа) — вынесено сюда, чтобы не дублировать. Сами
// промпты (system-контент) остаются в вызывающем коде и в .txt-файлах,
// этот файл только про механику HTTP-вызова.
// ============================================================

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CallOpenAIChatOptions {
  model: string;
  temperature: number;
  messages: ChatMessage[];
  responseFormatJson?: boolean;
  label: string; // для сообщений об ошибке — какой вызывающий модуль (Extractor/Responder/Admin)
}

export async function callOpenAIChat(opts: CallOpenAIChatOptions): Promise<string> {
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
    throw new Error(`${opts.label} OpenAI call failed: ${response.status} ${errText}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error(`${opts.label}: empty response from OpenAI`);
  }
  return text;
}
