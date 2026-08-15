import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeConfig } from '../src/lib/config.mjs';
import { isPathInside, readJson } from '../src/lib/utils.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

test('init 在範例設定檔遺失時仍會產生完整設定', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codereel-init-'));
  context.after(async () => await fs.rm(temporaryRoot, { recursive: true, force: true }));
  const repo = path.join(temporaryRoot, 'source-repo');
  const destination = path.join(temporaryRoot, 'config', 'codereel.config.json');
  await fs.mkdir(repo, { recursive: true });

  await initializeConfig({
    sourceTemplate: path.join(projectRoot, 'missing-codereel.config.example.json'),
    destination,
    repoPath: repo,
  });

  const config = await readJson(destination);
  assert.equal(config.repoPath, repo);
  assert.equal(config.llm.model, 'auto');
  assert.equal(config.tts.voice, 'zh-TW-HsiaoChenNeural');
  assert.equal(config.slides.themeFile, path.join(projectRoot, 'templates', 'titanium-dark.json'));
});

test('init 分析 CodeReel 所在 repo 時會把輸出移到來源外', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codereel-self-'));
  context.after(async () => await fs.rm(temporaryRoot, { recursive: true, force: true }));
  const repo = path.join(temporaryRoot, 'CodeReel');
  const destination = path.join(repo, 'codereel.config.json');
  await fs.mkdir(repo, { recursive: true });

  await initializeConfig({
    sourceTemplate: path.join(projectRoot, 'codereel.config.example.json'),
    destination,
    repoPath: repo,
  });

  const config = await readJson(destination);
  assert.equal(path.isAbsolute(config.outputRoot), true);
  assert.equal(isPathInside(repo, config.outputRoot), false);
  assert.equal(isPathInside(config.outputRoot, repo), false);
});

test('init 缺少 --repo 時直接說明必要參數', async () => {
  await assert.rejects(
    () => initializeConfig({ sourceTemplate: '', destination: 'unused-config.json', repoPath: undefined }),
    /必須提供 --repo/u,
  );
});
