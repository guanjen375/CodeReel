import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildSourceBundle, scanRepository } from '../src/lib/repo-scan.mjs';

test('source bundle 加入行號後仍不超過 maxSourceChars', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codereel-bundle-'));
  await fs.writeFile(path.join(root, 'README.md'), `${'繁體中文內容。'.repeat(1000)}\n`, 'utf8');
  const config = {
    repoPath: root,
    outputRoot: path.join(root, '..', 'out'),
    cacheRoot: path.join(root, '..', 'cache'),
    runRoot: path.join(root, '..', 'out', 'run'),
    llm: { maxSourceChars: 500 },
    scan: {
      maxFiles: 20, maxFileBytes: 100000,
      excludeDirectories: ['.git'], excludeFiles: ['.env'], includeExtensions: ['.md'],
    },
  };
  const manifest = await scanRepository(config);
  const bundle = await buildSourceBundle(config, manifest, ['README.md']);
  assert.ok(bundle.text.length <= 500);
});
