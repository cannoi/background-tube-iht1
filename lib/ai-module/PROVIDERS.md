# Provider matrix

| Provider | Protocol | Key | Built-in Base URL | Model discovery |
|---|---|---|---|---|
| OpenAI | OpenAI-compatible | Yes | `https://api.openai.com/v1` | `GET /models` |
| Gemini | Native Gemini | Yes | `https://generativelanguage.googleapis.com/v1` | `GET /models` + `generateContent` capability filter |
| DeepSeek | OpenAI-compatible | Yes | `https://api.deepseek.com` | `GET /models` |
| Anthropic | Anthropic Messages | Yes | `https://api.anthropic.com/v1` | `GET /models` |
| OpenRouter | OpenAI-compatible | Yes | `https://openrouter.ai/api/v1` | `GET /models` |
| Groq | OpenAI-compatible | Yes | `https://api.groq.com/openai/v1` | `GET /models` |
| Mistral | OpenAI-compatible | Yes | `https://api.mistral.ai/v1` | `GET /models` |
| xAI | OpenAI-compatible | Yes | `https://api.x.ai/v1` | `GET /models` |
| Custom | OpenAI-compatible | Optional | User supplied | `GET <baseUrl>/models` |
| Local | OpenAI-compatible | Usually no | User supplied | `GET <baseUrl>/models` |

## Important

`model: auto` is **dynamic**. The module queries the provider's model list and selects a suitable text model. It does not trust a stale hard-coded model ID.

If a saved explicit model returns HTTP 404 / model-not-found, the module refreshes the provider model list, selects a valid fallback, retries once, and saves the recovered model.

Gemini uses the stable `v1` base URL by default. The model list is filtered to models advertising `generateContent` support. Google documents `v1` as the stable API version and the model list/generateContent APIs separately.

## Custom / Local (OpenAI-compatible) — how it talks to your server

Works with Ollama, LM Studio, llama.cpp `llama-server`, vLLM, LocalAI, Jan, LiteLLM, Open WebUI and any gateway that speaks the OpenAI Chat Completions dialect.

- **Base URL** may be `http://host:port`, `http://host:port/v1`, or even a pasted `.../v1/chat/completions`; the module normalises it and probes `/v1` when missing. No scheme → `http://` for localhost/private hosts, `https://` otherwise.
- **Model listing**: `GET <base>/models` (tolerates `{data}`, `{models}`, bare arrays, string arrays); falls back to Ollama `GET /api/tags`. Embedding / speech / image / rerank models are never auto-selected.
- **No `/models` on your server?** Type the exact model name in Settings → Model. This always works.
- **Generation**: `POST <base>/chat/completions`; if the endpoint does not exist the module tries `POST <base>/responses`, then Ollama `POST /api/chat`.
- **Auto-adaptation**: retries without `temperature`, folds the system prompt into the user turn, drops `max_tokens`/`stream` when the server rejects them.
- **Reasoning models**: inline `<think>…</think>` blocks are removed before JSON parsing.
- **Key**: optional. A pasted `Bearer ` prefix is stripped. Extra headers for gateways: env `AI_EXTRA_HEADERS='{"X-Gateway":"id"}'` (or `extraHeaders` in `data/ai-settings.json`).
- **Timeouts**: 120 s for Custom/Local, 60 s for cloud; override with `AI_TIMEOUT_MS`.
- **Docker**: use `http://host.docker.internal:11434/v1` instead of `localhost`.

Error codes returned by `/api/ai/chat` and `/api/ai/test`: `NO_MODEL`, `BAD_BASE_URL`, `NETWORK_ERROR`, `TIMEOUT`, `EMPTY_RESPONSE`, `AUTH_ERROR`, `FORBIDDEN`, `MODEL_OR_ENDPOINT_NOT_FOUND`, `RATE_LIMIT`, `AI_PROVIDER_ERROR`.
