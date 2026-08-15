import test from 'node:test';
import assert from 'node:assert/strict';
import { runProcess } from '../src/lib/utils.mjs';

test('runProcess 保留跨 chunk 的 UTF-8 中文', async () => {
  const script = 'const b=Buffer.from("課");process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),10)';
  const result = await runProcess(process.execPath, ['-e', script]);
  assert.equal(result.stdout, '課');
});
