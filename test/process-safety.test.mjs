import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findCommand, runProcess } from '../src/lib/utils.mjs';

test('findCommand 不解析 shell substitution', async () => {
  const marker = path.join(os.tmpdir(), `codereel-command-${process.pid}.txt`);
  await fs.rm(marker, { force: true });
  assert.equal(await findCommand(`$(echo injected > ${marker})`), null);
  assert.equal(await fs.stat(marker).then(() => true).catch(() => false), false);
});

test('runProcess 預設不把 key 類環境變數交給子程序', async () => {
  process.env.CODEREEL_CANARY_SECRET = 'do-not-leak';
  try {
    const result = await runProcess(process.execPath, ['-e', 'process.stdout.write(process.env.CODEX_CANARY_SECRET || process.env.CODEREEL_CANARY_SECRET || "missing")']);
    assert.equal(result.stdout, 'missing');
  } finally {
    delete process.env.CODEREEL_CANARY_SECRET;
  }
});

test('子程序提前關閉 stdin 不會造成未處理的 EPIPE', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.exit(0)'], {
    input: 'x'.repeat(2_000_000), allowFailure: true,
  });
  assert.equal(result.code, 0);
});
