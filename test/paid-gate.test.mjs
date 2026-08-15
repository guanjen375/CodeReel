import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { synthesizeNarration } from '../src/lib/tts.mjs';
import { assertLlmPrivacy } from '../src/lib/llm.mjs';

test('Azure 未明確核准時在網路呼叫前停止', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codereel-paid-'));
  process.env.TEST_AZURE_REGION = 'eastus';
  const config = {
    cacheRoot: path.join(root, 'cache'),
    paths: {
      audio: path.join(root, 'audio'),
      ssml: path.join(root, 'audio', 'ssml'),
      intermediate: path.join(root, 'intermediate'),
      egressReport: path.join(root, 'intermediate', 'egress.json'),
    },
    llm: { timeoutMs: 1000 },
    tts: {
      provider: 'azure', voice: 'zh-TW-HsiaoChenNeural', rate: '-6%',
      outputFormat: 'audio-24khz-96kbitrate-mono-mp3',
      maxBillableCharacters: 30000, maxEstimatedCost: 10, maxAudioBytesPerSlide: 26214400,
      azureKeyEnv: 'TEST_AZURE_KEY_THAT_IS_NOT_SET',
      azureRegionEnv: 'TEST_AZURE_REGION',
      azureEndpointEnv: 'TEST_AZURE_ENDPOINT_THAT_IS_NOT_SET',
    },
  };
  try {
    await fs.mkdir(config.paths.audio, { recursive: true });
    const existing = path.join(config.paths.audio, 'slide-001.wav');
    await fs.writeFile(existing, 'existing-output');
    await assert.rejects(
      () => synthesizeNarration(config, [{ slide: 1, title: '一', spoken: '測試', spokenCharacters: 2 }]),
      (error) => error.code === 'PAID_APPROVAL_REQUIRED',
    );
    assert.equal(await fs.stat(existing).then(() => true, () => false), true);
    const report = JSON.parse(await fs.readFile(config.paths.egressReport, 'utf8'));
    assert.equal(report.billableCharacters, 2);
    assert.equal(report.items[0].text, '測試');
    assert.match(report.approvalDigest, /^[a-f0-9]{64}$/u);
    await assert.rejects(
      () => synthesizeNarration(config, [{ slide: 1, title: '一', spoken: '已變更', spokenCharacters: 3 }], { approvedEgressDigest: report.approvalDigest }),
      (error) => error.code === 'PAID_APPROVAL_REQUIRED',
    );
  } finally {
    delete process.env.TEST_AZURE_REGION;
  }
});

test('requireLocalLlm 會拒絕非 loopback 端點', () => {
  assert.throws(() => assertLlmPrivacy({
    llm: { provider: 'openai-compatible', baseUrl: 'https://example.com/v1' },
    privacy: { requireLocalLlm: true },
  }), /不是 loopback/u);
});
