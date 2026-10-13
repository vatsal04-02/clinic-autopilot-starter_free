# Ollama: local AI for W13 (no paid API) + the deterministic FAQ fallback

**Demo / local only.** The AI receptionist (W13) can ask a model running on the same machine (Ollama) instead of OpenRouter. No key, no account, no cost per message.
What the model may do is unchanged: it writes a JSON decision; W13's own code checks it (schema, confidence, fact check, emergency and hand-off rules) and W12 is still the only thing that sends.

## 1. What is added

`node n8n/integrated/apply-ollama-provider.js --in <workflow.json> [--out <file>] [--demo] [--keep-private]`

| | |
|---|---|
| New nodes (6) | `W13 – Provider?` (IF: `model_provider` = `ollama`) → `W13 – Ollama Request` → `W13 – Ollama Ready?` → `W13 – Ask Ollama` (POST `<ollama_base_url>/api/chat`, **no credential**) → `W13 – Ollama Answer` → `W13 – Plan`; plus a Read Me sticky |
| Changed nodes (3) | `W13 – Config` (7 new values), `W13 – Plan` (FAQ fallback block + tail), `W13 – Record Sends` (the Run_Log trace names the Ollama model, not the OpenRouter one). Each is checked first; the patcher refuses and writes nothing if the node was edited |
| Rewired (2) | `W13 – Claim?` (false) and `W13 – Claim Message` (ok) now go to `W13 – Provider?`. `openrouter` goes to the old node: **nothing changes for OpenRouter** |
| Untouched | the OpenRouter nodes, every gate, W12, W2, credentials, webhooks. `apply-ollama-provider.js` without `--demo` leaves `model_provider = openrouter` and `faq_fallback = off` |

## 2. Settings (W13 – Config) and safe defaults

| Key | Default | Meaning |
|---|---|---|
| `model_provider` | `ollama` (with `--demo`; `openrouter` otherwise) | exact word `ollama` (any case / spaces) selects Ollama. Anything else goes to the OpenRouter node, which stops the run on a typo, as before |
| `ollama_base_url` | `http://host.docker.internal:11434` | bare `http(s)://host[:port]`. **Local or private hosts only**: `localhost`, `127.x`, `host.docker.internal`, a Docker service name (`http://ollama:11434`), `10.x`, `172.16–31.x`, `192.168.x`, `*.local`, `*.internal`, `*.ts.net`. A public host is refused (patient messages must not leave by accident) unless `ollama_allow_remote` is `true` |
| `ollama_model` | `qwen2.5:7b-instruct` | any pulled model. This default is a suggestion, **not tested here** (see §6) |
| `ollama_timeout_ms` | `60000` | 1 000–600 000. A cold model load can take longer than a warm answer; one attempt only, no retries |
| `ollama_num_ctx` | `8192` | context window. The prompt (rules ≈ 3 000 tokens + knowledge base + history) is estimated **before** the call; if it does not fit, no call is made (Ollama would silently cut off the rules) |
| `ollama_keep_alive` | `10m` | how long Ollama keeps the model loaded |
| `ollama_allow_remote` | `false` | see `ollama_base_url` |
| `faq_fallback` | `on` (`--demo`) / `off` | see §4 |

Nothing is sent by choosing a provider: sending is still decided by each clinic's `Settings > ai_mode` (`off` default / `draft` / `auto`) and by W12 (`w12_send_mode`; `simulate` sends nothing, see `MISSED-CALL-CAPTURE.md`).
There are no new environment variables: the values above live in the `W13 – Config` node (plain values, editable in n8n). If you prefer environment variables, set them on the n8n container and write `={{ $env.OLLAMA_BASE_URL }}` in the node; that needs `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` and is not used by default.

## 3. What happens when Ollama is not usable

Not running, DNS, timeout, HTTP error, model not pulled, empty answer, text that is not JSON, JSON that breaks the schema, answer cut off, prompt too big, a bad setting: all become the same thing, "the AI gave no usable decision". The message is already marked `processing` (no double replies), so the run does **not** crash:

* `faq_fallback = off` → the usual safe hand-off: the patient gets the clinic's holding message, a person is alerted, `Needs_Human` is set, the reason is in `Messages > AI_Reason`.
* `faq_fallback = on` → see §4, otherwise the same hand-off.

## 4. The deterministic FAQ fallback (`n8n/snippets/ai-faq-fallback.js`)

Only when the model gave nothing usable. A **clear routine question** is answered from the clinic's Knowledge table with no model: prices, services, opening hours, address, a hello, a thank-you ("ok"/"thanks" get no reply).

* The reply is built only from active knowledge rows whose text is short enough to quote whole; a price, time, link or phone not in the Knowledge table is impossible. The decision goes through `aiValidateDecision`, `aiPlan` and the fact check like a model's, so a row the fact check cannot read (a time written in words, Devanagari digits, an unknown `{{placeholder}}`) is handed off instead.
* It never answers: bookings or availability ("book", "tomorrow", "slot", "cancel"), medical questions (should I…, medicines, exercises, "worse"), complaints and refunds, requests for a person, messages with links, anything over 120 characters, a question with a topic the knowledge base does not hold, insurance / offers / parking / packages, or an emergency (the gates hand those to a person before the model or the fallback is reached).
* Replies are in the language the Knowledge table is written in (English by default). Hindi / Devanagari / Hinglish *questions* about prices, timings, address and services are recognised, but the answer is the knowledge row as written.
* The Run_Log record and `AI_Reason` say `fallback: FAQ fallback (the AI was unusable: <why>)`.

## 5. Tests

```
node n8n/snippets/ai-ollama.test.js                       # adapter: settings, request, 18 failure shapes (network trapped)
node n8n/snippets/ai-faq-fallback.test.js                 # FAQ: 11 answered, 26 refused, KB gaps, fact check
node n8n/integrated/ollama-provider.test.js               # the patched workflow end to end (W2 → W13 → W12), O1–O13
node n8n/integrated/ollama-provider-mutations.test.js     # 16 deliberate breaks, each must be caught
node n8n/tests/ollama-smoke.js                            # OPTIONAL, real Ollama; prints SKIP when none is running
node n8n/tests/run-all.js                                 # everything (the smoke test is not part of it)
```

## 6. What is verified, and what is not

* **Verified (mocked):** every line above that says "test": request shape, settings and safety checks, all failure shapes, fallback behaviour, gates, emergency path, injection, quiet hours, draft mode, TEST_MODE, mutation checks. The "Ollama" in these tests is a fake that answers from the real prompt.
* **Not verified here:** a real Ollama. The sandbox cannot reach `ollama.com`, so no model was pulled or run. Unproven: that your model returns valid JSON for the decision schema (self-hosted Ollama 0.5+ is documented to enforce a JSON schema passed as `format`; a small model can still answer badly, and then the fallback / hand-off applies), the exact error text n8n puts in the `{ error }` item (the classifier handles the shapes listed in `ai-ollama.test.js`), and `options.timeout` being accepted as an expression by your n8n version (check the node's Options after import; if not, type the number there).
* **Hindi / Hinglish:** the rules tell the model to answer in the patient's language, but **no quality claim is made**. Run `n8n/tests/ollama-smoke.js` and read the replies before relying on a model for Hindi.

## 7. Running Ollama next to n8n

```
ollama serve                       # or the official Docker image; models are several GB
ollama pull qwen2.5:7b-instruct    # or another instruct model
```
If n8n runs in Docker and Ollama on the host, add `extra_hosts: ["host.docker.internal:host-gateway"]` to the n8n service (Linux), or use the Docker service name in `ollama_base_url`. Do not publish Ollama's port (11434) to the internet; it has no authentication.
