import fs from 'node:fs/promises';
import { isLoopbackUrl, readJson, stripBom } from './utils.mjs';

function validatedBaseUrl(config) {
  let url;
  try { url = new URL(config.llm.baseUrl); }
  catch { throw new Error(`LLM baseUrl 無效：${config.llm.baseUrl}`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('LLM baseUrl 只允許無帳密、query 與 fragment 的 HTTP(S) URL。');
  }
  if (config.privacy.requireLocalLlm && !isLoopbackUrl(url.href)) {
    throw new Error(`privacy.requireLocalLlm=true，但 LLM 端點不是 loopback：${config.llm.baseUrl}`);
  }
  return url.href.replace(/\/$/u, '');
}

export function llmSetupInstructions(config) {
  const endpoint = String(config.llm.baseUrl || '未設定');
  if (config.llm.provider === 'ollama') {
    return [
      '安裝 Ollama：winget install --id Ollama.Ollama --exact --accept-package-agreements --accept-source-agreements',
      '下載快速驗證模型：ollama pull qwen3:4b-instruct',
      `確認端點：${endpoint}/api/tags`,
      '重新執行：npm run codereel -- doctor',
    ];
  }
  return [
    `啟動目前設定的 OpenAI-compatible 服務：${endpoint}`,
    '或把 llm.provider 改為 ollama、baseUrl 改為 http://127.0.0.1:11434，再安裝並啟動 Ollama。',
    '重新執行：npm run codereel -- doctor',
  ];
}

function localLlmConnectionError(config, cause) {
  const error = new Error(`無法連線到本機 LLM：${config.llm.baseUrl}\n${llmSetupInstructions(config).map((step) => `- ${step}`).join('\n')}`);
  error.code = 'LLM_ENDPOINT_UNREACHABLE';
  error.cause = cause;
  return error;
}

async function fetchLocalLlm(url, options, config) {
  try {
    return await fetch(url, options);
  } catch (error) {
    if (error?.name === 'TimeoutError') {
      const timeoutError = new Error(`本機 LLM 等候超過 ${config.llm.timeoutMs} 毫秒；可提高 llm.timeoutMs 後重試。`);
      timeoutError.code = 'LLM_TIMEOUT';
      timeoutError.cause = error;
      throw timeoutError;
    }
    throw localLlmConnectionError(config, error);
  }
}

async function readResponseText(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`LLM 回應超過 ${maxBytes} bytes 上限。`);
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`LLM 回應超過 ${maxBytes} bytes 上限。`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString('utf8');
}

function extractJson(text) {
  const cleaned = stripBom(String(text).trim());
  try {
    return JSON.parse(cleaned);
  } catch {}
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  if (fenced) return JSON.parse(fenced[1]);
  const start = Math.min(...['{', '['].map((token) => {
    const index = cleaned.indexOf(token);
    return index < 0 ? Number.POSITIVE_INFINITY : index;
  }));
  if (!Number.isFinite(start)) throw new Error('模型回應沒有 JSON。');
  const opener = cleaned[start];
  const closer = opener === '{' ? '}' : ']';
  const end = cleaned.lastIndexOf(closer);
  if (end <= start) throw new Error('模型回應的 JSON 不完整。');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function ollamaErrorDetail(rawText) {
  const raw = String(rawText || '').trim();
  if (!raw) return '';
  let outer;
  try { outer = JSON.parse(raw); }
  catch { return raw.slice(0, 2000); }
  let detail = outer?.error ?? outer?.message ?? raw;
  if (typeof detail === 'string') {
    try {
      const nested = JSON.parse(detail);
      detail = nested?.error?.message ?? nested?.message ?? detail;
    } catch {}
  } else if (detail && typeof detail === 'object') {
    detail = detail.message ?? JSON.stringify(detail);
  }
  return String(detail || '').slice(0, 2000);
}

async function ollamaHttpError(response, config, label) {
  let detail = '';
  try {
    detail = ollamaErrorDetail(await readResponseText(response, Math.min(config.llm.maxResponseBytes, 65536)));
  } catch {}
  const contextHint = /context size|exceed_context_size/iu.test(detail)
    ? '\n請降低 llm.maxSourceChars，或提高 llm.contextWindow。'
    : '';
  const error = new Error(`${label}：HTTP ${response.status}${detail ? `\n${detail}` : ''}${contextHint}`);
  error.code = 'OLLAMA_HTTP_ERROR';
  error.status = response.status;
  return error;
}

export function createGenerationConfig(config, resolvedModel) {
  const generation = { ...config, llm: { ...config.llm, model: resolvedModel } };
  if (generation.llm.provider === 'ollama') {
    generation.llm.maxSourceChars = Math.min(generation.llm.maxSourceChars, generation.llm.contextWindow);
  }
  return generation;
}

async function discoverOpenAiModel(baseUrl, headers, timeoutMs, maxBytes, config) {
  const response = await fetchLocalLlm(`${baseUrl.replace(/\/$/u, '')}/models`, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  }, config);
  if (!response.ok) throw new Error(`無法讀取本機模型清單：HTTP ${response.status}`);
  const payload = JSON.parse(await readResponseText(response, maxBytes));
  const model = payload?.data?.[0]?.id;
  if (!model) throw new Error('本機端點沒有回傳可用模型。');
  return model;
}

async function callOpenAiCompatible(messages, config) {
  const baseUrl = validatedBaseUrl(config);
  const headers = { 'content-type': 'application/json' };
  if (config.llm.apiKeyEnv) {
    const key = process.env[config.llm.apiKeyEnv];
    if (key) headers.authorization = `Bearer ${key}`;
  }
  const model = config.llm.model === 'auto'
    ? await discoverOpenAiModel(baseUrl, headers, config.llm.timeoutMs, config.llm.maxResponseBytes, config)
    : config.llm.model;
  const response = await fetchLocalLlm(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages,
      temperature: config.llm.temperature,
      stream: false,
    }),
    signal: AbortSignal.timeout(config.llm.timeoutMs),
    redirect: 'error',
  }, config);
  if (!response.ok) throw new Error(`本機 LLM 回應失敗：HTTP ${response.status}`);
  const payload = JSON.parse(await readResponseText(response, config.llm.maxResponseBytes));
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) throw new Error('本機 LLM 回應缺少 message.content。');
  return { content, model, usage: payload.usage || null };
}

async function callOllama(messages, config, jsonSchema = null) {
  const baseUrl = validatedBaseUrl(config).replace(/\/v1$/u, '');
  let model = config.llm.model;
  if (model === 'auto') {
    const tags = await fetchLocalLlm(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(config.llm.timeoutMs), redirect: 'error' }, config);
    if (!tags.ok) throw await ollamaHttpError(tags, config, '無法讀取 Ollama 模型清單');
    model = JSON.parse(await readResponseText(tags, config.llm.maxResponseBytes))?.models?.[0]?.name;
    if (!model) throw new Error('Ollama 沒有已安裝模型。');
  }
  const response = await fetchLocalLlm(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      format: jsonSchema || 'json',
      options: {
        temperature: config.llm.temperature,
        num_ctx: config.llm.contextWindow,
      },
    }),
    signal: AbortSignal.timeout(config.llm.timeoutMs),
    redirect: 'error',
  }, config);
  if (!response.ok) throw await ollamaHttpError(response, config, 'Ollama 回應失敗');
  const payload = JSON.parse(await readResponseText(response, config.llm.maxResponseBytes));
  return { content: payload?.message?.content, model, usage: { promptEvalCount: payload.prompt_eval_count, evalCount: payload.eval_count } };
}

export function assertLlmPrivacy(config) {
  if (config.llm.provider === 'fixture') return;
  validatedBaseUrl(config);
}

export async function resolveLlmModel(config) {
  if (config.llm.provider === 'fixture') return 'fixture';
  assertLlmPrivacy(config);
  if (config.llm.model !== 'auto') return config.llm.model;
  const baseUrl = validatedBaseUrl(config);
  if (config.llm.provider === 'ollama') {
    const response = await fetchLocalLlm(`${baseUrl.replace(/\/v1$/u, '')}/api/tags`, {
      signal: AbortSignal.timeout(config.llm.timeoutMs), redirect: 'error',
    }, config);
    if (!response.ok) throw await ollamaHttpError(response, config, '無法讀取 Ollama 模型清單');
    const model = JSON.parse(await readResponseText(response, config.llm.maxResponseBytes))?.models?.[0]?.name;
    if (!model) throw new Error('Ollama 沒有已安裝模型。');
    return model;
  }
  const headers = {};
  if (config.llm.apiKeyEnv && process.env[config.llm.apiKeyEnv]) headers.authorization = `Bearer ${process.env[config.llm.apiKeyEnv]}`;
  return await discoverOpenAiModel(baseUrl, headers, config.llm.timeoutMs, config.llm.maxResponseBytes, config);
}

export async function requestJson(messages, config, validate = null, jsonSchema = null) {
  if (config.llm.provider === 'fixture') {
    if (!config.llm.fixturePlan) throw new Error('fixture provider 缺少 llm.fixturePlan。');
    const value = await readJson(config.llm.fixturePlan);
    if (validate) await validate(value);
    return { value, model: 'fixture', usage: null };
  }
  assertLlmPrivacy(config);
  let currentMessages = [...messages];
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = config.llm.provider === 'ollama'
      ? await callOllama(currentMessages, config, jsonSchema)
      : await callOpenAiCompatible(currentMessages, config);
    try {
      const value = extractJson(response.content);
      if (validate) await validate(value);
      return { value, model: response.model, usage: response.usage };
    } catch (error) {
      lastError = error;
      currentMessages = [
        ...messages,
        { role: 'user', content: `前一個 JSON 無法使用：${error.message}\n請重新產生完整內容，只輸出符合 schema 的 JSON。` },
      ];
    }
  }
  throw new Error(`模型連續三次未產生有效 JSON：${lastError?.message || 'unknown error'}`);
}

export async function loadFixtureSelection(config, manifest) {
  const plan = JSON.parse(stripBom(await fs.readFile(config.llm.fixturePlan, 'utf8')));
  const requested = new Set();
  for (const slide of plan.slides || []) for (const evidence of slide.evidence || []) requested.add(evidence.path);
  return [...requested].filter((item) => manifest.files.some((file) => file.path === item));
}
