import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeConfig, loadConfig } from '../src/lib/config.mjs';
import {
  assertLlmPrivacy, claudeCliArgs, claudeCliContent, claudeCliModel, claudeCliPrompt,
  claudeModelCandidates, claudeModelChoices, claudeShimTargets, llmSetupInstructions,
  modelMatchesRequest, parseClaudeCliEnvelope, resolveLlmModel,
} from '../src/lib/llm.mjs';
import { readJson, writeJsonAtomic } from '../src/lib/utils.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

function claudeConfig(overrides = {}) {
  return {
    llm: {
      provider: 'claude-cli',
      claudeExecutable: 'claude',
      model: 'auto',
      timeoutMs: 600000,
      maxResponseBytes: 4194304,
      ...overrides,
    },
    privacy: { requireLocalLlm: false },
  };
}

const messages = [
  { role: 'system', content: '只輸出 JSON。' },
  { role: 'user', content: '{"task":"產生課程"}' },
];

test('claude-cli 以無工具、無自訂設定的方式執行', () => {
  const args = claudeCliArgs(claudeConfig(), messages);
  assert.ok(args.includes('--print'));
  assert.deepEqual(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2), ['--output-format', 'json']);
  assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', '']);
  assert.ok(args.includes('--safe-mode'));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('--no-session-persistence'));
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.ok(!args.includes('--allow-dangerously-skip-permissions'));
});

test('system 訊息走 --system-prompt，其餘訊息走 stdin', () => {
  const args = claudeCliArgs(claudeConfig(), messages);
  assert.equal(args[args.indexOf('--system-prompt') + 1], '只輸出 JSON。');
  assert.equal(claudeCliPrompt(messages), '{"task":"產生課程"}');
});

test('model=auto 不指定 --model；指定模型時才傳入', () => {
  assert.ok(!claudeCliArgs(claudeConfig(), messages).includes('--model'));
  const pinned = claudeCliArgs(claudeConfig({ model: 'claude-opus-5' }), messages);
  assert.equal(pinned[pinned.indexOf('--model') + 1], 'claude-opus-5');
});

test('JSON Schema 會轉交給 --json-schema', () => {
  const schema = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } };
  const args = claudeCliArgs(claudeConfig(), messages, schema);
  assert.equal(args[args.indexOf('--json-schema') + 1], JSON.stringify(schema));
});

test('有 --json-schema 時取 structured_output，沒有時才退回 result', () => {
  const structured = parseClaudeCliEnvelope(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: '已完成。',
    structured_output: { ok: true },
  }));
  assert.equal(claudeCliContent(structured), '{"ok":true}');

  const plain = parseClaudeCliEnvelope(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: '{"ok":true}',
  }));
  assert.equal(claudeCliContent(plain), '{"ok":true}');

  assert.throws(
    () => parseClaudeCliEnvelope(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '' })),
    /缺少 structured_output 與 result/u,
  );
});

test('記錄實際產出的模型，不受輔助模型影響', () => {
  const payload = {
    modelUsage: {
      'claude-haiku-4-5-20251001': { inputTokens: 458, outputTokens: 15 },
      'claude-opus-4-8[1m]': { inputTokens: 1437, outputTokens: 151 },
    },
  };
  assert.equal(claudeCliModel(payload, 'claude-code-default'), 'claude-opus-4-8[1m]');
  assert.equal(claudeCliModel({}, 'claude-code-default'), 'claude-code-default');
});

test('認證失敗回傳可執行的修復方式', () => {
  assert.throws(
    () => parseClaudeCliEnvelope(JSON.stringify({
      type: 'result', subtype: 'success', is_error: true, api_error_status: 401,
      result: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
    })),
    (error) => error.code === 'CLAUDE_CLI_AUTH' && /claude auth login/u.test(error.message),
  );
});

test('用量上限與一般錯誤分開回報', () => {
  assert.throws(
    () => parseClaudeCliEnvelope(JSON.stringify({
      type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: 'usage limit reached',
    })),
    (error) => error.code === 'CLAUDE_CLI_RATE_LIMIT',
  );
  assert.throws(
    () => parseClaudeCliEnvelope(JSON.stringify({
      type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom',
    })),
    (error) => error.code === 'CLAUDE_CLI_ERROR',
  );
  assert.throws(() => parseClaudeCliEnvelope('not json'), /不是 JSON/u);
});

test('init 預設就是 claude-cli，且不宣稱只用本機 LLM', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codereel-claude-init-'));
  context.after(async () => await fs.rm(temporaryRoot, { recursive: true, force: true }));
  const repo = path.join(temporaryRoot, 'source-repo');
  const destination = path.join(temporaryRoot, 'codereel.config.json');
  await fs.mkdir(repo, { recursive: true });

  await initializeConfig({
    sourceTemplate: path.join(projectRoot, 'codereel.config.example.json'),
    destination,
    repoPath: repo,
  });

  const written = await readJson(destination);
  assert.equal(written.llm.provider, 'claude-cli');
  assert.equal(written.privacy.requireLocalLlm, false);
  assert.equal((await loadConfig(destination)).llm.claudeExecutable, 'claude');
});

test('claude-cli 搭配 requireLocalLlm=true 會直接拒絕，不會靜默送出原始碼', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codereel-claude-privacy-'));
  context.after(async () => await fs.rm(temporaryRoot, { recursive: true, force: true }));
  const repo = path.join(temporaryRoot, 'source-repo');
  const destination = path.join(temporaryRoot, 'codereel.config.json');
  await fs.mkdir(repo, { recursive: true });

  await initializeConfig({
    sourceTemplate: path.join(projectRoot, 'codereel.config.example.json'),
    destination,
    repoPath: repo,
  });
  const config = await readJson(destination);
  config.privacy.requireLocalLlm = true;
  await writeJsonAtomic(destination, config);

  await assert.rejects(() => loadConfig(destination), /requireLocalLlm=true/u);
});

test('候選模型清單可由設定檔覆寫，不必等程式更新', () => {
  assert.deepEqual(claudeModelCandidates(claudeConfig()), claudeModelChoices);
  assert.deepEqual(claudeModelCandidates(claudeConfig({ modelCandidates: [] })), claudeModelChoices);
  assert.deepEqual(
    claudeModelCandidates(claudeConfig({ modelCandidates: ['opus', { value: '未來模型', summary: '新推出' }, { summary: '沒有名稱' }] })),
    [{ value: 'opus', summary: '' }, { value: '未來模型', summary: '新推出' }],
  );
});

test('指定模型被靜默換掉時要判定為不相符', () => {
  assert.equal(modelMatchesRequest('opus', 'claude-opus-5'), true);
  assert.equal(modelMatchesRequest('sonnet', 'claude-sonnet-5[1m]'), true);
  assert.equal(modelMatchesRequest('haiku', 'claude-haiku-4-5-20251001'), true);
  assert.equal(modelMatchesRequest('claude-opus-5', 'claude-opus-5'), true);
  assert.equal(modelMatchesRequest('sonnet[1m]', 'claude-sonnet-5[1m]'), true);
  assert.equal(modelMatchesRequest('auto', 'claude-opus-5[1m]'), true);
  assert.equal(modelMatchesRequest('fable', 'claude-opus-5'), false);
  assert.equal(modelMatchesRequest('opusplan', 'claude-sonnet-5'), false);
  assert.equal(modelMatchesRequest('opus', ''), false);
});

test('Windows 批次檔 shim 會解析回真正的執行檔', () => {
  const shim = [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
    '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
  ].join('\n');
  assert.deepEqual(
    claudeShimTargets(shim, 'C:\\tools\\bin'),
    [path.join('C:\\tools\\bin', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')],
  );
  assert.deepEqual(claudeShimTargets('沒有可執行檔路徑', 'C:\\tools\\bin'), []);
});

test('claude-cli 不需要 baseUrl，也不做 loopback 檢查', async () => {
  const config = claudeConfig();
  assert.doesNotThrow(() => assertLlmPrivacy(config));
  assert.equal(await resolveLlmModel(config), 'auto');
  assert.equal(await resolveLlmModel(claudeConfig({ model: 'claude-sonnet-5' })), 'claude-sonnet-5');
  assert.ok(llmSetupInstructions(config).some((step) => step.includes('claude auth login')));
});
