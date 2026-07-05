// ============================================================
// INKA-BOT — Live dialog log (Telegram forum topics)
// Зеркалит переписку клиент↔Инка в отдельную супергруппу с топиками —
// чтобы Аня видела диалоги в реальном времени, не мешая рабочему чату
// с ботом (там команды /счёт, /портрет, /расписание).
//
// Полностью опционально: без TELEGRAM_LOG_GROUP_ID — no-op, ничего не
// падает и не меняется в основном пайплайне.
//
// НАСТРОЙКА (один раз, вручную у Ани):
//   1. Создать супергруппу в Telegram → в её настройках включить Topics
//      (Форум-режим).
//   2. Добавить бота в группу администратором с правом "Manage Topics".
//   3. Получить chat_id группы (отрицательное число) и задать в Vercel
//      как TELEGRAM_LOG_GROUP_ID.
// Каждому клиенту при первом сообщении создаётся свой топик (по имени),
// id сохраняется в Airtable (поле log_topic_id) и переиспользуется дальше.
// ============================================================

import { updateClient, type ClientRecord } from './airtable';

interface TelegramApiError extends Error {
  telegramDescription?: string;
}

async function callTelegramApi(method: string, body: Record<string, any>): Promise<any> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!data?.ok) {
    const err: TelegramApiError = new Error(
      `Telegram ${method} failed: ${res.status} ${JSON.stringify(data)}`
    );
    err.telegramDescription = data?.description ?? '';
    throw err;
  }
  return data.result;
}

async function createTopic(groupId: string, clientLabel: string): Promise<number | null> {
  const topic = await callTelegramApi('createForumTopic', {
    chat_id: groupId,
    name: clientLabel.slice(0, 128), // Telegram: имя топика ≤128 символов
  });
  return topic?.message_thread_id ?? null;
}

async function sendToTopic(groupId: string, topicId: number, text: string): Promise<void> {
  await callTelegramApi('sendMessage', {
    chat_id: groupId,
    message_thread_id: topicId,
    text,
  });
}

// Собирает текст одного "хода" диалога для лога — отдельная чистая
// функция, чтобы формат можно было проверить тестом без сети.
export function buildMirrorText(
  clientMessage: string | null,
  inkaReply: string | null
): string | null {
  const lines: string[] = [];
  if (clientMessage) lines.push(`👤 ${clientMessage}`);
  if (inkaReply) lines.push(`🤖 ${inkaReply}`);
  return lines.length > 0 ? lines.join('\n\n') : null;
}

// Зеркалит один обмен репликами в топик супергруппы мастера. Топик
// создаётся при первом обращении к клиенту и переиспользуется дальше
// (id хранится в Airtable). Если топик был вручную удалён в Telegram —
// пересоздаётся один раз и id в Airtable обновляется.
//
// Вызывается уже ПОСЛЕ отправки ответа клиенту — никогда не бросает
// исключение наружу, сбой логирования не должен ломать основной пайплайн.
export async function mirrorDialog(
  record: ClientRecord | null,
  clientLabel: string,
  clientMessage: string | null,
  inkaReply: string | null
): Promise<void> {
  const groupId = process.env.TELEGRAM_LOG_GROUP_ID;
  if (!groupId || !record) return;

  const text = buildMirrorText(clientMessage, inkaReply);
  if (!text) return;

  try {
    let topicId: number | null = null;
    const existingId = Number(record.fields.log_topic_id);
    if (!Number.isNaN(existingId) && existingId > 0) {
      topicId = existingId;
    }
    if (!topicId) {
      topicId = await createTopic(groupId, clientLabel);
      if (!topicId) return;
      // Сохраняем id для переиспользования в будущих сообщениях этого же
      // клиента. Если сохранить не получилось (например поле log_topic_id
      // ещё не добавлено в Airtable) — НЕ даём этому сорвать отправку
      // самого сообщения: топик уже реально создан в Telegram, молчать в
      // него из-за отдельной ошибки записи было бы хуже, чем просто не
      // переиспользовать топик в следующий раз. Раньше ошибка здесь
      // уходила во внешний catch ДО sendToTopic — топик создавался, но
      // текст в него так и не попадал, и на каждое новое сообщение
      // создавался ещё один пустой топик.
      try {
        await updateClient(record.id, { log_topic_id: topicId });
      } catch (persistErr) {
        console.error('mirrorDialog: failed to persist log_topic_id (non-fatal):', persistErr);
      }
    }

    try {
      await sendToTopic(groupId, topicId, text);
    } catch (err) {
      // Топик мог быть удалён вручную в Telegram — пересоздаём один раз,
      // а не теряем сообщение молча.
      const desc = (err as TelegramApiError)?.telegramDescription ?? '';
      if (/thread not found|topic.*not found/i.test(desc)) {
        const freshTopicId = await createTopic(groupId, clientLabel);
        if (freshTopicId) {
          await updateClient(record.id, { log_topic_id: freshTopicId });
          await sendToTopic(groupId, freshTopicId, text);
        }
      } else {
        throw err;
      }
    }
  } catch (err) {
    console.error('mirrorDialog failed (non-fatal):', err);
  }
}
