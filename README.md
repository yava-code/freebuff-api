# freebuff-api

**EN** | [RU ниже](#русский)

One command turns your local **Freebuff Desktop** login into an **OpenAI-compatible API** on your own machine:

```bash
npx github:yava-code/freebuff-api
```

The script:

1. **Finds your token** (never leaves your machine): `CODEBUFF_API_KEY` env → `FREEBUFF_DESKTOP_STATE_PATH` env → `~/.config/freebuff-desktop/state.json` → legacy `~/.codebuff/credentials.json`.
2. **Prints the token and the endpoint** in the console.
3. **Serves an OpenAI-compatible API** on `http://127.0.0.1:8787/v1`:

| Endpoint | Description |
|---|---|
| `GET /health` | liveness + default model |
| `GET /v1/models` | OpenAI-style model list (with Freebuff display names) |
| `GET /v1/models/{id}` | single model |
| `POST /v1/chat/completions` | chat, `stream: true` supported |

Point any OpenAI client at it:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"z-ai/glm-5.3-flash","messages":[{"role":"user","content":"hi"}]}'
```

Python (`openai` SDK):

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="local")
print(client.chat.completions.create(
    model="z-ai/glm-5.3-flash",
    messages=[{"role": "user", "content": "hi"}],
).choices[0].message.content)
```

## Why updates can't break it

The bridge **never installs anything into the Freebuff app folder** (app updates overwrite that folder). It only ever *reads* your token from a stable per-user config path at every start — so app updates, re-installs and re-logins all keep working. If Freebuff adds or renames models, just update the small catalog in `lib/models.js` (or send a PR).

## Free mode via the official CLI

With the official Freebuff CLI installed once (`npm install -g freebuff`), the bridge runs every request through it — the genuine client the backend grants free-mode inference to, so **0 credits** are spent:

1. The CLI's TUI is driven like a user would (stdin: Enter → prompt → Enter). No headers are forged.
2. The CLI itself writes the transcript to disk; the bridge reads the assistant's reply from there.
3. Requests are queued (one TUI at a time); a request takes ~30–60 s end-to-end.

Backend selection via `FREEBUFF_API_BACKEND`:

| Value | Behavior |
|---|---|
| `auto` (default) | CLI if installed (free), per-request fallback to the SDK |
| `cli` | CLI only — free mode, 0 credits |
| `sdk` | SDK only — bills credits, honest `402` without them |

Failed CLI runs (TUI races, timeouts) transparently fall back to the SDK in `auto` mode and are reported via `freebuff.cliFallbackReason` in the response.

## Honest billing note

Free-mode inference on the Freebuff backend is restricted to its official clients. This bridge therefore goes through the **official `@codebuff/sdk`** with your own token: each request runs a tiny chat agent pinned to the model you requested, and bills against your account credits. Without credits the backend answers `402`, and the bridge returns a clear OpenAI-style error (no workaround hacks — the backend explicitly warns about bans for header spoofing). Inside the official Freebuff app, free mode keeps working as usual.

## Security

- Server binds to **127.0.0.1 only** — unreachable from other machines.
- CORS is open so browser apps on your machine can call it.
- Your token is printed to *your* console and sent *only* to the Codebuff backend as an `Authorization` header. Nothing is stored or sent anywhere else.

MIT licensed. Not affiliated with Codebuff/Freebuff.

---

<a id="русский"></a>
# Русский

Одна команда превращает твой вход в **Freebuff Desktop** в **OpenAI-совместимый API** на твоём компьютере:

```bash
npx github:yava-code/freebuff-api
```

Скрипт:

1. **Находит токен** (никуда не отправляет): `CODEBUFF_API_KEY` → `FREEBUFF_DESKTOP_STATE_PATH` → `~/.config/freebuff-desktop/state.json` → legacy `~/.codebuff/credentials.json`.
2. **Печатает токен и endpoint** в консоль.
3. **Поднимает OpenAI-совместимый API** на `http://127.0.0.1:8787/v1` (`/models`, `/chat/completions`, стрим поддерживается).

## Почему обновления приложения не страшны

Мост **ничего не устанавливает в папку приложения** (её затирают обновления). Он только *читает* токен из стабильного пути в профиле пользователя при каждом запуске — поэтому обновления, переустановка и перелогин не ломают его. Новые модели Freebuff добавляются правкой одного файла `lib/models.js`.

## Бесплатный режим через официальный CLI

Достаточно один раз поставить официальный CLI Freebuff (`npm install -g freebuff`) — и мост прогоняет каждый запрос через него, подлинный клиент, которому бэкенд разрешает бесплатный режим. **0 кредитов.**

1. TUI CLI управляется как живым пользователем (stdin: Enter → промпт → Enter). Заголовки не подделываются.
2. CLI сам пишет транскрипт диалога на диск; мост забирает ответ ассистента оттуда.
3. Запросы выстраиваются в очередь (один TUI за раз); запрос занимает ~30–60 с.

Выбор бэкенда через `FREEBUFF_API_BACKEND`:

| Значение | Поведение |
|---|---|
| `auto` (по умолчанию) | CLI, если установлен (бесплатно), с фолбэком на SDK |
| `cli` | только CLI — бесплатный режим, 0 кредитов |
| `sdk` | только SDK — списывает кредиты, честный `402` без них |

Неудачный прогон CLI (гонки TUI, таймаут) в режиме `auto` прозрачно падает на SDK, причина видна в ответе в `freebuff.cliFallbackReason`.

## Честно про оплату

Бесплатный режим бэкенд Freebuff отдаёт только официальным клиентам. Поэтому мост работает через **официальный `@codebuff/sdk`** с твоим токеном: каждый запрос запускает лёгкого чат-агента под выбранную модель и списывает кредиты аккаунта. Без кредитов бэкенд отвечает `402`, и мост возвращает понятную OpenAI-ошибку (обход защиты не делаем — бэкенд прямо предупреждает о бане за подмену заголовков). В самом приложении Freebuff бесплатный режим работает как раньше.

MIT. Не является продуктом Codebuff/Freebuff.
