# ContentINKA ↔ Дневник — что нужно реализовать на стороне Дневника

Памятка для разработчика Дневника (`dnevnik-mastera`): что именно нужно,
чтобы Дневник мог отдавать фото сессии в ContentINKA и получать обратно
готовую подборку. ContentINKA — отдельный сервис; Дневник обращается к нему
**напрямую из браузера**, не через какой-то свой сервер — у Дневника нет
бэкенда, это чистое SPA (Vite + React), вся база в IndexedDB на устройстве.
Паттерн ровно тот же, что уже работает для календаря: `src/lib/calendarSync.ts`
шлёт fetch из браузера в `pages/api/diary-sync.ts` (бот), с секретом из
localStorage и открытым CORS на принимающей стороне. ContentINKA нужно
встраивать так же.

## Что уже есть в Дневнике и не нужно строить заново

- **Фото уже загружаются — и у сессий, и у консультаций.**
  `Session.photos: string[]` и `Consultation.photos: string[]` — компонент
  `SessionPhotos` (`TattoDiary.tsx`), фото читаются через `FileReader` и
  хранятся как **base64 data URL**, не файлы на диске и не URL. Апдейтит их
  `updateSessionPhotos(sessionId, photos)` (и аналог для консультаций).
  Новую загрузку изобретать не нужно — ContentINKA цепляется к этому же полю.
- **Триггер — кнопка «Отправить в контент», не флаг.** У `Session.done`
  нет эквивалента у `Consultation` (запланированная консультация — тоже
  валидный источник контента, «вот что мы придумываем», не только
  прошедшая). Единая кнопка в карточке обоих типов, независимо от `done`.
- **Контекст — два разных маппинга, есть `source_type`:**
  - `session`: `client` = `${client.name} ${client.surname}`,
    `work` = `session.name`, `zone` = `session.area`,
    `style` = `session.style`, `description` = `session.note`.
  - `consultation`: `client` — тот же, `zone` = `consultation.area`,
    `style` = `consultation.style`, `description` — конкатенация
    `generalNotes` + `feeling` + `creative` + `inspirationSources` (полей
    больше и они конкретнее, чем `note` у сессии).
  - `generalNotes`/`creative` консультации — сырой личный черновик мастера
    (поток сознания, может быть с матом), не готовый текст для зрителя.
    В промпте это нужно явно пометить: извлекать смысл (тему, метафору),
    не цитировать дословно.

## Что нужно добавить

1. **Новый модуль по образцу `calendarSync.ts`** — например
   `src/lib/contentSync.ts`: настройки (`enabled`, `endpoint`, `secret`) в
   своём ключе localStorage (не `inka-calendar-sync`, отдельный — например
   `inka-content-sync`), fetch к ContentINKA с `Authorization: Bearer
   <секрет>`.
2. **Кнопка «Отправить в контент»** — в карточке `Session` и в карточке
   `Consultation`, не привязана к `done`. Отправляет `photos` + контекст +
   `source_type: "session" | "consultation"` (маппинг полей см. выше).
3. **Хранение ответа** — новое поле на `Session`/`Consultation` (например
   `contentDraft: ContentMedia[] | null`) для результата классификации;
   рисуется как окно/вкладка «Контент» внутри карточки (готовый пакет по
   роли/качеству для сессии, упрощённый — без role/format — для
   консультации; ручная панель, строка коммуникации с моделью — см.
   `contentinka-design.md`).
4. **Отправка инструкций мастера** — при вводе текста в строку
   коммуникации у материала — вызов на ContentINKA с ссылкой на конкретный
   `media.id`.

Решение «оставить/убрать/вернуть» кадр (`master_decision`) хранится только в
`Session.contentDraft` на стороне Дневника — ContentINKA этого решения
обратно не требует для минимальной версии.

## Важно: фото — это base64, не URL, и передаются превью, не оригиналы

У Дневника нет сервера, значит нет и стабильного URL, по которому
ContentINKA могла бы сама скачать фото. **Фото передаются целиком в теле
запроса как data URL**, а не ссылкой.

**Размер запроса решаем сжатием, не дроблением по фото.** Один оригинал
из `session.photos` легко весит несколько МБ, в сессии может быть десятки
фото — serverless-функции (Vercel) по умолчанию режут тело запроса на
~4.5 МБ. Дробить на запрос-на-фото было бы проще, но тогда модель теряет
возможность сравнивать фото сессии между собой — а именно на этом
сравнении строится `role` (общий вид/деталь/финал — они относительны друг
друга), `cover_candidate` (лучшее из нескольких) и порядок кадров. Поэтому
вместо дробления — **даунсайз на клиенте перед отправкой**: перед вызовом
`/ingest` каждое фото из `session.photos` сжимается через `<canvas>` до
~512–768px по длинной стороне (несколько строк JS, `canvas.toDataURL(...)`
с JPEG-качеством ~0.7). Такое превью весит десятки-сотни КБ вместо
мегабайт — вся сессия целиком укладывается в один запрос. Оригиналы
(из `session.photos`) остаются как есть в Дневнике для показа/скачивания,
на вход модели не идут вообще.

## Эндпоинт 1 — `POST /ingest`

Вызывается по кнопке «Отправить в контент» в карточке сессии или
консультации, со всеми превью сразу.

**Запрос (сессия):**
```json
{
  "session_id": "diary-session-id",
  "source_type": "session",
  "session": {
    "client": "Александра",
    "work": "Голубика",
    "zone": "Левое плечо",
    "style": "минимализм",
    "description": "..."
  },
  "media": [
    { "id": "photo-0", "preview_data_url": "data:image/jpeg;base64,..." },
    { "id": "photo-1", "preview_data_url": "data:image/jpeg;base64,..." }
  ]
}
```

**Запрос (консультация)** — тот же эндпоинт, другой `source_type` и другой
набор полей в `session`:
```json
{
  "session_id": "diary-consultation-id",
  "source_type": "consultation",
  "session": {
    "client": "Валерия",
    "zone": "Спина",
    "style": "...",
    "description": "generalNotes + feeling + creative + inspirationSources, склеенные вместе"
  },
  "media": [{ "id": "ref-0", "preview_data_url": "data:image/jpeg;base64,..." }]
}
```
- `session_id` — id записи в Дневнике, сквозной идентификатор (ContentINKA
  ничего не хранит между вызовами).
- `media[].id` — стабильный идентификатор фото на стороне Дневника
  (индекс в массиве `photos` или хэш), чтобы сопоставить ответ с
  конкретным элементом массива.
- `media[].preview_data_url` — сжатое превью (см. выше), не оригинал.

**Ответ (`source_type: "session"`):**
```json
{
  "media": [{
    "id": "photo-0",
    "technical_status": "kept",
    "role": "detail",
    "quality_score": 0.78,
    "has_depth_data": true,
    "cover_candidate": false,
    "format": "post",
    "order_index": 3,
    "visual_archetype": "lover",
    "text_triad": { "opens": "explorer", "leads": "sage", "closes": "fool" },
    "text_draft": "...",
    "master_decision": "pending"
  }]
}
```

**Ответ (`source_type: "consultation"`)** — без `role`/`quality_score`/
`cover_candidate`/`format`/`order_index` (не применимо к референсам, см.
дизайн-документ):
```json
{
  "media": [{
    "id": "ref-0",
    "technical_status": "kept",
    "visual_archetype": "trickster",
    "text_triad": { "opens": "explorer", "leads": "sage", "closes": "creator" },
    "text_draft": "...",
    "master_decision": "pending"
  }]
}
```

Отклонённые на техническом этапе фото тоже возвращаются с
`technical_status: "rejected"` (и причиной) — чтобы мастер могла нажать
«вернуть». `order_index` уже учитывает всю сессию — отдельный шаг для
порядка не нужен.

## Эндпоинт 2 — `POST /media/{media_id}/instruct`

Вызывается, когда мастер пишет инструкцию к конкретному уже готовому
материалу. Тело запроса должно повторно включать `preview_data_url` этого
фото и `session` — ContentINKA ничего не хранит между вызовами, поэтому не
может восстановить фото сама по `media_id`.

**Запрос:**
```json
{
  "session": { "client": "...", "work": "...", "zone": "...", "style": "...", "description": "..." },
  "preview_data_url": "data:image/jpeg;base64,...",
  "master_instruction": "смени триаду на Мудрец-Дурак-Творец"
}
```

**Ответ** — обновлённый объект (тот же формат, что из `/ingest`),
плюс опционально `internal_card`, если инструкция была просьбой объяснить
механику, а не перегенерировать:
```json
{
  "media": { "...": "как выше, с обновлённым text_draft/triad" },
  "internal_card": {
    "goal": "...",
    "viewer_state_before": "...",
    "viewer_state_after": "...",
    "visual_archetype": "lover",
    "text_triad": { "opens": "...", "leads": "...", "closes": "..." },
    "shadow_risk": "..."
  }
}
```
`internal_card` в интерфейсе показывается только когда мастер сама
попросила — по умолчанию скрыта.

## Глоссарий полей (для UI Дневника)

- `technical_status` — `kept` (в основной пайплайн) / `background` (смазан,
  но эстетично — кандидат в фон под текст/подложку, не мусор) / `rejected`
  (дубль, UI-мусор, или брак настолько сильный, что не годится даже как
  фон). У `background`-кадров нет `role`/`text_triad` — их отдельно можно
  показать в Дневнике как «фоны» рядом с основным пакетом.
- `role` — `overview` / `detail` / `process` / `final` (только для
  `technical_status: "kept"`).
- `quality_score` — 0–1, визуальное качество кадра.
- `has_depth_data` — есть depth/Portrait-данные (iPhone) — кадр гибче.
- `cover_candidate` — годится в обложку.
- `format` — `post` / `story` (без видео `reel` в v1 не используется).
- `order_index` — порядок фото внутри подборки (уже учитывает всю сессию).
- `visual_archetype` — какой архетип говорит через фото (один из семи).
- `text_triad` — три архетипа текста с ролями `opens`/`leads`/`closes`.
- `text_draft` — готовый черновик подписи.
- `master_decision` — `pending` / `confirmed` / `removed` — управляется и
  хранится Дневником, ContentINKA не читает и не пишет это поле.

Названия архетипов и логика голоса бренда — справочно, если понадобится
контекст: `contentinka-archetypes.md`, `contentinka-brand-voice.md` в
репозитории `inka-bot`. Для интеграции сама философия не нужна — только
контракт полей выше.

## Что пока не решено

- Тайм-аут `/ingest`: один batch-вызов vision-модели на всю сессию (10-30
  фото-превью) может занимать десятки секунд. Нужен индикатор загрузки на
  UI Дневника с достаточным тайм-аутом (~60-90с), а не мгновенный отклик.
- Порог сжатия превью (512 vs 768px, качество JPEG) — подбирается
  эмпирически на реальных фото, см. `contentinka-classification-prompt.md`
  в `inka-bot`.
