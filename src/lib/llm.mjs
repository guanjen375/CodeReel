import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findCommand, isLoopbackUrl, readJson, runProcess, stripBom } from './utils.mjs';

const claudeSessionEnvNames = [
  'AI_AGENT', 'ANTHROPIC_BASE_URL', 'CLAUDECODE', 'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_HOST_SESSION_ID', 'CLAUDE_CODE_OAUTH_SCOPES', 'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH',
  'CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_EFFORT', 'CLAUDE_PID',
];

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
  if (config.llm.provider === 'claude-cli') {
    return [
      '安裝 Claude Code CLI：npm install -g @anthropic-ai/claude-code',
      '用 Claude 訂閱帳號登入：claude auth login',
      '確認登入狀態：claude auth status',
      '重新執行：npm run codereel -- doctor',
    ];
  }
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

export function claudeExecutableName(config) {
  return String(config.llm.claudeExecutable || 'claude').trim() || 'claude';
}

export function claudeShimTargets(shimText, shimDirectory) {
  const targets = [];
  for (const match of String(shimText).matchAll(/"([^"\n]*\.exe)"/giu)) {
    targets.push(path.resolve(shimDirectory, match[1].replace(/%~?dp0%/giu, `${shimDirectory}${path.sep}`)));
  }
  return targets;
}

async function resolveClaudeExecutable(requested) {
  const found = await findCommand(requested);
  if (!found || process.platform !== 'win32' || !/\.(?:cmd|bat)$/iu.test(found)) return found;
  const directory = path.dirname(found);
  const candidates = [
    path.join(directory, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    ...claudeShimTargets(await fs.readFile(found, 'utf8').catch(() => ''), directory),
  ];
  for (const candidate of candidates) {
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isFile()) return candidate;
  }
  const error = new Error([
    `Claude Code CLI 只找到批次檔：${found}`,
    'Windows 不允許直接執行 .cmd／.bat，CodeReel 也不透過 shell 執行外部命令。',
    '請把設定檔的 llm.claudeExecutable 改成 claude.exe 的完整路徑，例如：',
    path.join(directory, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
  ].join('\n'));
  error.code = 'CLAUDE_CLI_NOT_EXECUTABLE';
  throw error;
}

export function claudeCliArgs(config, messages, jsonSchema = null) {
  const system = messages.filter((item) => item.role === 'system').map((item) => String(item.content)).join('\n\n');
  const args = [
    '--print',
    '--output-format', 'json',
    '--tools', '',
    '--safe-mode',
    '--strict-mcp-config',
    '--no-session-persistence',
  ];
  if (system) args.push('--system-prompt', system);
  if (config.llm.model && config.llm.model !== 'auto') args.push('--model', String(config.llm.model));
  if (jsonSchema) args.push('--json-schema', JSON.stringify(jsonSchema));
  return args;
}

export function claudeCliPrompt(messages) {
  return messages.filter((item) => item.role !== 'system').map((item) => String(item.content)).join('\n\n');
}

export function claudeCliEnvelopeError(payload) {
  const detail = String(payload?.result || payload?.error || '').slice(0, 2000);
  const status = Number(payload?.api_error_status) || null;
  if (status === 401 || status === 403 || /authenticat|oauth|unauthorized/iu.test(detail)) {
    const error = new Error(`Claude Code CLI 未通過認證：${detail}\n- 在一般終端機執行：claude auth login\n- 桌面版 App 的登入狀態與 CLI 分開，App 可用不代表 CLI 可用。`);
    error.code = 'CLAUDE_CLI_AUTH';
    return error;
  }
  if (status === 429 || /rate limit|usage limit|quota/iu.test(detail)) {
    const error = new Error(`Claude Code 用量已達上限：${detail}\n請稍後再執行，或先用 npm run codereel -- analyze 分段推進。`);
    error.code = 'CLAUDE_CLI_RATE_LIMIT';
    return error;
  }
  const error = new Error(`Claude Code CLI 回應失敗：${detail || `subtype=${payload?.subtype ?? 'unknown'}`}`);
  error.code = 'CLAUDE_CLI_ERROR';
  if (status) error.status = status;
  return error;
}

export function claudeCliContent(payload) {
  const structured = payload?.structured_output;
  if (structured && typeof structured === 'object') return JSON.stringify(structured);
  if (payload?.result) return String(payload.result);
  return '';
}

export function claudeCliModel(payload, fallback) {
  const entries = Object.entries(payload?.modelUsage || {});
  if (entries.length === 0) return fallback;
  return entries.reduce((best, entry) => (Number(entry[1]?.outputTokens) > Number(best[1]?.outputTokens) ? entry : best))[0];
}

export function parseClaudeCliEnvelope(stdout) {
  const text = stripBom(String(stdout || '')).trim();
  if (!text) throw new Error('Claude Code CLI 沒有輸出。');
  let payload;
  try { payload = JSON.parse(text); }
  catch { throw new Error(`Claude Code CLI 輸出不是 JSON：${text.slice(0, 500)}`); }
  if (payload?.is_error || payload?.subtype !== 'success') throw claudeCliEnvelopeError(payload);
  if (!claudeCliContent(payload)) throw new Error('Claude Code CLI 回應缺少 structured_output 與 result。');
  return payload;
}

function claudeCliUsage(payload) {
  const usage = payload?.usage || {};
  return {
    inputTokens: usage.input_tokens ?? null,
    outputTokens: usage.output_tokens ?? null,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? null,
    numTurns: payload?.num_turns ?? null,
    totalCostUsd: payload?.total_cost_usd ?? null,
  };
}

async function callClaudeCli(messages, config, jsonSchema = null) {
  const requested = claudeExecutableName(config);
  const executable = await resolveClaudeExecutable(requested);
  if (!executable) {
    const error = new Error(`找不到 Claude Code CLI：${requested}\n${llmSetupInstructions(config).map((step) => `- ${step}`).join('\n')}`);
    error.code = 'CLAUDE_CLI_NOT_FOUND';
    throw error;
  }
  const result = await runProcess(executable, claudeCliArgs(config, messages, jsonSchema), {
    cwd: os.tmpdir(),
    input: claudeCliPrompt(messages),
    allowFailure: true,
    timeoutMs: config.llm.timeoutMs,
    maxOutputChars: config.llm.maxResponseBytes,
    excludeEnv: claudeSessionEnvNames,
  });
  if (result.timedOut) {
    const error = new Error(`Claude Code CLI 等候超過 ${config.llm.timeoutMs} 毫秒；可提高 llm.timeoutMs 後重試。`);
    error.code = 'LLM_TIMEOUT';
    throw error;
  }
  if (result.error) {
    const error = new Error(`無法執行 Claude Code CLI：${executable}\n${result.error.message}`);
    error.code = 'CLAUDE_CLI_NOT_EXECUTABLE';
    error.cause = result.error;
    throw error;
  }
  let payload;
  try {
    payload = parseClaudeCliEnvelope(result.stdout);
  } catch (error) {
    if (error.code) throw error;
    if (result.code !== 0) {
      const failure = new Error(`Claude Code CLI 執行失敗（exit ${result.code}）\n${String(result.stderr || result.stdout || '').slice(0, 2000)}`);
      failure.code = 'CLAUDE_CLI_ERROR';
      throw failure;
    }
    throw error;
  }
  const fallbackModel = config.llm.model && config.llm.model !== 'auto' ? String(config.llm.model) : 'claude-code-default';
  return {
    content: claudeCliContent(payload),
    model: claudeCliModel(payload, fallbackModel),
    usage: claudeCliUsage(payload),
  };
}

async function claudeCliAuthStatus(executable) {
  const result = await runProcess(executable, ['auth', 'status'], {
    cwd: os.tmpdir(),
    allowFailure: true,
    timeoutMs: 30000,
    excludeEnv: claudeSessionEnvNames,
  });
  try {
    const payload = JSON.parse(stripBom(String(result.stdout || '')).trim());
    return {
      loggedIn: Boolean(payload.loggedIn),
      authMethod: payload.authMethod || null,
      subscriptionType: payload.subscriptionType || null,
    };
  } catch {
    return { loggedIn: null, authMethod: null, subscriptionType: null };
  }
}

export const claudeModelChoices = ['fable', 'opus', 'sonnet', 'haiku'];

function claudeConfigFile() {
  const directory = process.env.CLAUDE_CONFIG_DIR || os.homedir();
  return path.join(directory, '.claude.json');
}

export function claudeCachedModelNames(stored) {
  const options = stored?.additionalModelOptionsCache;
  if (!Array.isArray(options)) return [];
  return options.map((item) => String(item?.value ?? '').trim()).filter(Boolean);
}

async function claudeDiscoveredModels() {
  try {
    return claudeCachedModelNames(JSON.parse(stripBom(await fs.readFile(claudeConfigFile(), 'utf8'))));
  } catch {
    return [];
  }
}

async function claudeProbe(config, model) {
  const probeConfig = {
    ...config,
    llm: { ...config.llm, model, timeoutMs: Math.min(config.llm.timeoutMs, 120000) },
  };
  return await callClaudeCli([
    { role: 'system', content: '你是連線檢查回應器。只輸出 ok。' },
    { role: 'user', content: 'ok' },
  ], probeConfig);
}

export function claudeModelCandidates(config, discovered = []) {
  const configured = (config?.llm?.modelCandidates ?? []).map((item) => String(item ?? '').trim()).filter(Boolean);
  const base = configured.length > 0 ? configured : claudeModelChoices;
  return [...new Set([...base, ...discovered])].filter((value) => value !== 'auto');
}

export async function detectClaudeModels(config) {
  const candidates = claudeModelCandidates(config, await claudeDiscoveredModels());
  const probed = await Promise.all(candidates.map(async (value) => {
    try {
      await claudeProbe(config, value);
      return value;
    } catch {
      return null;
    }
  }));
  return probed.filter(Boolean);
}

export async function checkClaudeCli(config) {
  const requested = claudeExecutableName(config);
  let executable = null;
  try {
    executable = await resolveClaudeExecutable(requested);
  } catch (error) {
    return {
      available: false, provider: 'claude-cli', local: false, executable: null,
      error: error.message,
      nextSteps: llmSetupInstructions(config),
    };
  }
  if (!executable) {
    return {
      available: false, provider: 'claude-cli', local: false, executable: null,
      error: `找不到 Claude Code CLI：${requested}`,
      nextSteps: llmSetupInstructions(config),
    };
  }
  const auth = await claudeCliAuthStatus(executable);
  const status = {
    available: false, provider: 'claude-cli', local: false, executable,
    loggedIn: auth.loggedIn, authMethod: auth.authMethod, subscriptionType: auth.subscriptionType,
    selectedModel: config.llm.model,
  };
  try {
    const probe = await claudeProbe(config, config.llm.model);
    status.available = true;
    status.probedModel = probe.model;
  } catch (error) {
    status.error = error.message;
    status.nextSteps = llmSetupInstructions(config);
  }
  return status;
}

export function assertLlmPrivacy(config) {
  if (config.llm.provider === 'fixture' || config.llm.provider === 'claude-cli') return;
  validatedBaseUrl(config);
}

export async function resolveLlmModel(config) {
  if (config.llm.provider === 'fixture') return 'fixture';
  if (config.llm.provider === 'claude-cli') return config.llm.model && config.llm.model !== 'auto' ? String(config.llm.model) : 'auto';
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

async function callProvider(messages, config, jsonSchema) {
  if (config.llm.provider === 'claude-cli') return await callClaudeCli(messages, config, jsonSchema);
  if (config.llm.provider === 'ollama') return await callOllama(messages, config, jsonSchema);
  return await callOpenAiCompatible(messages, config);
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
    const response = await callProvider(currentMessages, config, jsonSchema);
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
