import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { requestJson } from '../src/lib/llm.mjs';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('本機 LLM redirect 不會把 prompt 轉送到第二個端點', async () => {
  let destinationRequests = 0;
  const destination = http.createServer((request, response) => {
    destinationRequests += 1;
    response.end('{}');
  });
  const destinationPort = await listen(destination);
  const source = http.createServer((request, response) => {
    response.writeHead(307, { location: `http://127.0.0.1:${destinationPort}/capture` });
    response.end();
  });
  const sourcePort = await listen(source);
  try {
    const config = {
      llm: {
        provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${sourcePort}/v1`, model: 'local-test',
        timeoutMs: 2000, maxResponseBytes: 65536, temperature: 0,
      },
      privacy: { requireLocalLlm: true },
    };
    await assert.rejects(() => requestJson([{ role: 'user', content: 'CANARY_PROMPT' }], config));
    assert.equal(destinationRequests, 0);
  } finally {
    await close(source);
    await close(destination);
  }
});
