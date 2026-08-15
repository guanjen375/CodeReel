import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanRepository } from '../src/lib/repo-scan.mjs';

test('repo 掃描排除秘密、相依目錄與 binary', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codereel-scan-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules', 'x'), { recursive: true });
  await fs.writeFile(path.join(root, 'README.md'), '# Demo\n');
  await fs.writeFile(path.join(root, 'src', 'main.mjs'), 'export const ok = true;\n');
  await fs.writeFile(path.join(root, '.env'), 'API_KEY=do-not-read\n');
  await fs.writeFile(path.join(root, 'src', 'leaked.mjs'), "export const token = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456';\n");
  await fs.writeFile(path.join(root, 'node_modules', 'x', 'index.js'), 'bad\n');
  await fs.writeFile(path.join(root, 'src', 'blob.bin'), Buffer.from([0, 1, 2]));
  const manifest = await scanRepository({
    repoPath: root,
    scan: {
      maxFileBytes: 1024,
      maxFiles: 100,
      includeExtensions: ['.md', '.mjs', '.js', '.bin'],
      excludeDirectories: ['.git', 'node_modules'],
      excludeFiles: ['.env'],
    },
  });
  assert.deepEqual(manifest.files.map((file) => file.path), ['README.md', 'src/main.mjs']);
  assert.deepEqual(manifest.skipped.sensitive, ['.env']);
  assert.deepEqual(manifest.skipped.secretContent, ['src/leaked.mjs']);
  assert.ok(!JSON.stringify(manifest).includes('do-not-read'));
});
