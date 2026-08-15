import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeConfig, resolveConfigPath, setActiveConfig } from '../src/lib/config.mjs';
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

test('init 連續處理不同 repo 時自動建立獨立設定檔', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codereel-multi-init-'));
  context.after(async () => await fs.rm(temporaryRoot, { recursive: true, force: true }));
  const firstRepo = path.join(temporaryRoot, 'FirstRepo');
  const secondRepo = path.join(temporaryRoot, 'SecondRepo');
  const defaultDestination = path.join(temporaryRoot, 'codereel.config.json');
  await fs.mkdir(firstRepo, { recursive: true });
  await fs.mkdir(secondRepo, { recursive: true });

  const first = await initializeConfig({
    sourceTemplate: path.join(projectRoot, 'codereel.config.example.json'),
    destination: defaultDestination,
    repoPath: firstRepo,
    autoName: true,
  });
  const second = await initializeConfig({
    sourceTemplate: path.join(projectRoot, 'codereel.config.example.json'),
    destination: defaultDestination,
    repoPath: secondRepo,
    autoName: true,
  });
  const repeated = await initializeConfig({
    sourceTemplate: path.join(projectRoot, 'codereel.config.example.json'),
    destination: defaultDestination,
    repoPath: secondRepo,
    autoName: true,
  });

  assert.equal(first.path, defaultDestination);
  assert.equal(first.created, true);
  assert.equal(second.path, path.join(temporaryRoot, 'SecondRepo.config.json'));
  assert.equal(second.created, true);
  assert.equal(repeated.path, second.path);
  assert.equal(repeated.created, false);
  assert.equal((await readJson(second.path)).repoPath, secondRepo);
});

test('init 選定的設定檔可供後續命令直接沿用', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codereel-active-config-'));
  context.after(async () => await fs.rm(temporaryRoot, { recursive: true, force: true }));
  const repo = path.join(temporaryRoot, 'SourceRepo');
  const configPath = path.join(temporaryRoot, 'SourceRepo.config.json');
  await fs.mkdir(repo, { recursive: true });

  await initializeConfig({
    sourceTemplate: path.join(projectRoot, 'codereel.config.example.json'),
    destination: configPath,
    repoPath: repo,
  });
  const pointerPath = await setActiveConfig(configPath, temporaryRoot);

  assert.equal(await resolveConfigPath(undefined, temporaryRoot), configPath);
  assert.equal((await readJson(pointerPath)).configPath, configPath);
  assert.equal(
    await resolveConfigPath('.\\explicit.config.json', temporaryRoot),
    path.join(temporaryRoot, 'explicit.config.json'),
  );
});

test('目前設定紀錄損壞或目標消失時不會退回舊設定', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codereel-active-fail-'));
  context.after(async () => await fs.rm(temporaryRoot, { recursive: true, force: true }));
  const configPath = path.join(temporaryRoot, 'current.config.json');
  await fs.writeFile(configPath, '{}\n', 'utf8');
  const pointerPath = await setActiveConfig(configPath, temporaryRoot);
  await fs.rm(configPath);

  await assert.rejects(() => resolveConfigPath(undefined, temporaryRoot), /目前設定檔已不存在/u);

  await fs.writeFile(pointerPath, '{broken', 'utf8');
  await assert.rejects(() => resolveConfigPath(undefined, temporaryRoot), /目前設定紀錄無法讀取/u);
});

test('目前設定紀錄不存在時不會沿用舊的預設設定', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codereel-active-missing-'));
  context.after(async () => await fs.rm(temporaryRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(temporaryRoot, 'codereel.config.json'), '{}\n', 'utf8');

  await assert.rejects(() => resolveConfigPath(undefined, temporaryRoot), /尚未選定目前專案/u);
});
