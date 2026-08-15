import test from 'node:test';
import assert from 'node:assert/strict';
import { llmSetupInstructions, resolveLlmModel } from '../src/lib/llm.mjs';

function unavailableOllamaConfig() {
  return {
    llm: {
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:1',
      model: 'auto',
      timeoutMs: 500,
      maxResponseBytes: 65536,
    },
    privacy: { requireLocalLlm: true },
  };
}

test('本機 LLM 未啟動時回傳可執行的修復方式', async () => {
  const config = unavailableOllamaConfig();
  await assert.rejects(
    () => resolveLlmModel(config),
    (error) => error.code === 'LLM_ENDPOINT_UNREACHABLE'
      && /無法連線到本機 LLM/u.test(error.message)
      && /winget install --id Ollama\.Ollama/u.test(error.message),
  );
  assert.ok(llmSetupInstructions(config).some((step) => step.includes('ollama pull qwen3:4b-instruct')));
});
