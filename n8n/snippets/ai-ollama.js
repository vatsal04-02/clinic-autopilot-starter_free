// Ollama provider for W13 (DEMO / local AI, no paid API). Same contract as ai-provider.js: W13's decision layer builds ONE request in the
// Anthropic Messages shape (aiBuildRequest) and reads ONE answer in that shape (aiParseResponse). Only these translations know Ollama;
// every check after the model answers (JSON validation, fact check, confidence tiers, emergency / hand-off rules) stays the same.
// Pure functions, no network, no clock. Pasted into the "W13 – Ollama Request" and "W13 – Ollama Answer" Code nodes.
// Paste from AI_OLLAMA_DEFAULTS down to (not including) the module.exports line.
//
// Ollama native chat API (POST <base_url>/api/chat, stream:false):
//   request : { model, messages:[system, user], format:<JSON schema>, options:{ temperature:0, num_predict, num_ctx }, keep_alive, stream:false }
//             `format` as a JSON schema is enforced by grammar-constrained decoding on a SELF-HOSTED Ollama (0.5 or newer). The answer is
//             still validated by W13 – Plan, so a model or server that ignores the schema produces a hand-off / FAQ fallback, never a send.
//   answer  : { message:{ content }, done, done_reason:'stop'|'length', prompt_eval_count, eval_count } -> the Anthropic-shaped answer.
// Safety defaults
//   * the base URL must be a bare http(s)://host[:port] on this machine or a private network (loopback, host.docker.internal, a
//     Docker service name, 10.x / 172.16-31.x / 192.168.x, *.local, *.internal, *.ts.net). A public host is refused unless
//     W13 – Config > ollama_allow_remote is true: patient messages are not sent to a third party by accident.
//   * the prompt is checked against num_ctx BEFORE the call: Ollama silently truncates what does not fit, which would cut off the rules.

const AI_OLLAMA_DEFAULTS = { base_url: 'http://host.docker.internal:11434', model: 'qwen2.5:7b-instruct', timeout_ms: 60000, num_ctx: 8192, keep_alive: '10m' };

function aiOllamaHostIsLocal(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h === '::1' || h === 'host.docker.internal' || h === 'gateway.docker.internal') return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
  }
  if (!h.includes('.')) return /^[a-z0-9][a-z0-9_-]*$/.test(h);   // a single-label name: a Docker / compose service (http://ollama:11434)
  return /\.(local|internal|lan|home\.arpa|ts\.net)$/.test(h);
}

// cfg: W13 – Config values (ollama_base_url, ollama_model, ollama_timeout_ms, ollama_num_ctx, ollama_keep_alive, ollama_allow_remote).
// Returns { ok:true, base_url, url, model, timeout_ms, num_ctx, keep_alive } or { ok:false, error }. Never throws.
function aiOllamaSettings(cfg) {
  const c = cfg || {};
  const pick = (v, d) => (v === undefined || v === null || String(v).trim() === '' ? d : v);
  const base = String(pick(c.ollama_base_url, AI_OLLAMA_DEFAULTS.base_url)).trim().replace(/\/+$/, '');
  const m = base.match(/^(https?):\/\/([A-Za-z0-9._-]+|\[[0-9A-Fa-f:]+\])(?::(\d{1,5}))?$/);
  if (!m) return { ok: false, error: `ollama_base_url "${base.slice(0, 80)}" must look like http://host:11434 (no path, no user:password, no query)` };
  if (m[3] !== undefined && (Number(m[3]) < 1 || Number(m[3]) > 65535)) return { ok: false, error: 'ollama_base_url has an invalid port' };
  const remoteOk = c.ollama_allow_remote === true || String(c.ollama_allow_remote).trim().toLowerCase() === 'true';
  if (!aiOllamaHostIsLocal(m[2]) && !remoteOk) return { ok: false, error: `ollama_base_url host "${m[2]}" is not on this machine or a private network; patient messages are not sent there (set ollama_allow_remote to true only if that is intended)` };
  const model = String(pick(c.ollama_model, AI_OLLAMA_DEFAULTS.model)).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,99}$/.test(model)) return { ok: false, error: `ollama_model "${model.slice(0, 60)}" is not an Ollama model name (for example qwen2.5:7b-instruct)` };
  const num = (v, d, lo, hi) => { const n = Number(pick(v, d)); return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : NaN; };
  const timeout_ms = num(c.ollama_timeout_ms, AI_OLLAMA_DEFAULTS.timeout_ms, 1000, 600000);
  if (Number.isNaN(timeout_ms)) return { ok: false, error: 'ollama_timeout_ms must be between 1000 and 600000' };
  const num_ctx = num(c.ollama_num_ctx, AI_OLLAMA_DEFAULTS.num_ctx, 2048, 131072);
  if (Number.isNaN(num_ctx)) return { ok: false, error: 'ollama_num_ctx must be between 2048 and 131072' };
  const keep_alive = String(pick(c.ollama_keep_alive, AI_OLLAMA_DEFAULTS.keep_alive)).trim();
  if (!/^(-1|\d{1,5}[smh]?)$/.test(keep_alive)) return { ok: false, error: 'ollama_keep_alive must look like 10m, 300s or -1' };
  return { ok: true, base_url: base, url: `${base}/api/chat`, model, timeout_ms, num_ctx, keep_alive };
}

// Rough prompt size in tokens. Latin text ~3 characters per token; Devanagari costs about one token per character in small models.
function aiOllamaEstimateTokens(text) {
  const s = String(text || '');
  const dev = (s.match(/[ऀ-ॿ]/g) || []).length;
  return Math.ceil((s.length - dev) / 3) + dev;
}

// req: the Anthropic-shaped request from aiBuildRequest; o: aiOllamaSettings(...) with ok true. Throws only on a programming error or a prompt
// that cannot fit num_ctx (the caller turns that into { error } so the message still gets a hand-off / FAQ answer).
function aiToOllama(req, o) {
  if (!o || o.ok !== true) throw new Error('aiToOllama needs valid settings');
  const system = (Array.isArray(req.system) ? req.system : [{ text: String(req.system || '') }]).map((b) => String(b.text || '')).filter(Boolean).join('\n\n');
  const messages = [{ role: 'system', content: system }, ...req.messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : (m.content || []).map((p) => p.text || '').join('\n') }))];
  const maxOut = Math.min(Number(req.max_tokens) || 1500, 1500);
  const need = aiOllamaEstimateTokens(messages.map((m) => m.content).join('\n')) + maxOut;
  if (need > o.num_ctx) throw new Error(`the prompt needs about ${need} tokens but ollama_num_ctx is ${o.num_ctx}: Ollama would cut off the rules; raise ollama_num_ctx (and check the model supports it)`);
  const fmt = req.output_config && req.output_config.format;
  const body = {
    model: o.model,
    stream: false,
    messages,
    options: { temperature: 0, num_predict: maxOut, num_ctx: o.num_ctx },
    keep_alive: o.keep_alive,
  };
  if (fmt && fmt.type === 'json_schema') body.format = fmt.schema;
  return body;
}

// resp: what n8n's HTTP node returned (Ollama's JSON, or n8n's { error } item), o: the settings. Returns the Anthropic-shaped answer that
// aiParseResponse reads, or { error }. Never throws.
function aiFromOllama(resp, o) {
  const fail = (message) => ({ error: { message: `Ollama: ${String(message).replace(/\s+/g, ' ').slice(0, 200)}` } });
  if (!resp || typeof resp !== 'object') return fail('no answer');
  if (resp.error) {
    const e = resp.error;
    const t = typeof e === 'string' ? e : (e.message || e.description || JSON.stringify(e));
    if (/timeout|timed out|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(t)) return fail(`timed out (${t})`);   // first: n8n words it "The connection timed out"
    if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET|socket hang up|getaddrinfo|refused|offline|connect/i.test(t)) return fail(`not reachable (${t})`);
    return fail(t);
  }
  const msg = resp.message;
  if (!msg || typeof msg !== 'object') return fail('the answer has no message');
  let text = typeof msg.content === 'string' ? msg.content : '';
  text = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/i, '$1').trim();   // a fenced JSON block -> the JSON (still parsed and checked)
  const ctx = o && o.num_ctx ? o.num_ctx : 0;
  const promptTokens = Number(resp.prompt_eval_count) || 0;
  if (ctx && promptTokens >= ctx - 8) return fail(`the prompt filled the whole context window (${promptTokens} of ${ctx} tokens): Ollama cut it off; raise ollama_num_ctx`);
  const stop = resp.done === false ? 'max_tokens' : resp.done_reason === 'length' ? 'max_tokens' : 'end_turn';
  return {
    type: 'message',
    role: 'assistant',
    model: String(resp.model || (o && o.model) || ''),
    content: text ? [{ type: 'text', text }] : [],
    stop_reason: stop,
    usage: { input_tokens: promptTokens, output_tokens: Number(resp.eval_count) || 0, provider: 'ollama', model: String(resp.model || (o && o.model) || '') },
  };
}

if (typeof module !== 'undefined') module.exports = { AI_OLLAMA_DEFAULTS, aiOllamaHostIsLocal, aiOllamaSettings, aiOllamaEstimateTokens, aiToOllama, aiFromOllama };
