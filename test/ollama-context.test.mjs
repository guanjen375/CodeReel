import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGenerationConfig, requestJson } from '../src/lib/llm.mjs';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function ollamaConfig(port) {
  return {
    llm: {
      provider: 'ollama',
      baseUrl: `http://127.0.0.1:${port}`,
      model: 'local-test',
      timeoutMs: 2000,
      contextWindow: 32768,
      maxResponseBytes: 65536,
      maxSourceChars: 180000,
      temperature: 0,
    },
    privacy: { requireLocalLlm: true },
  };
}

test('Ollama 請求使用指定 context 與原生 JSON Schema', async () => {
  let received;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        message: { content: '{"ok":true}' },
        prompt_eval_count: 12,
        eval_count: 4,
      }));
    });
  });
  const port = await listen(server);
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['ok'],
    properties: { ok: { type: 'boolean' } },
  };
  try {
    const result = await requestJson(
      [{ role: 'user', content: '輸出結果' }],
      ollamaConfig(port),
      (value) => assert.equal(value.ok, true),
      schema,
    );
    assert.equal(result.value.ok, true);
    assert.equal(received.options.num_ctx, 32768);
    assert.deepEqual(received.format, schema);
  } finally {
    await close(server);
  }
});

test('Ollama context 錯誤保留實際 token 數與修復提示', async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      error: JSON.stringify({
        error: {
          type: 'exceed_context_size_error',
          message: 'request (66019 tokens) exceeds the available context size (4096 tokens)',
        },
      }),
    }));
  });
  const port = await listen(server);
  try {
    await assert.rejects(
      () => requestJson([{ role: 'user', content: '輸出結果' }], ollamaConfig(port)),
      (error) => /66019 tokens/u.test(error.message)
        && /4096 tokens/u.test(error.message)
        && /降低 llm\.maxSourceChars/u.test(error.message),
    );
  } finally {
    await close(server);
  }
});

test('Ollama 會依 contextWindow 限制單次證據字元', () => {
  const config = ollamaConfig(11434);
  const generation = createGenerationConfig(config, 'qwen3:4b-instruct');
  assert.equal(generation.llm.maxSourceChars, 32768);
  assert.equal(config.llm.maxSourceChars, 180000);
});
