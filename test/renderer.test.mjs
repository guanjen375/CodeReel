import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeConfig, loadConfig } from '../src/lib/config.mjs';
import {
  checkRenderer, defaultRenderProvider, libreOfficeConvertArgs, pdfToPpmArgs, renderDeck,
} from '../src/lib/render.mjs';
import { readJson, writeJsonAtomic } from '../src/lib/utils.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

function libreOfficeConfig(overrides = {}) {
  return {
    slides: {
      renderProvider: 'libreoffice',
      libreOfficeExecutable: '完全不存在的-soffice',
      pdfToPpmExecutable: '完全不存在的-pdftoppm',
      ...overrides,
    },
    paths: { deckFile: 'deck.pptx', slides: 'slides', qa: 'qa', renderReport: 'r.json', overflowReport: 'o.json' },
  };
}

test('預設 renderer 依平台決定', () => {
  assert.equal(defaultRenderProvider('win32'), 'powerpoint');
  assert.equal(defaultRenderProvider('linux'), 'libreoffice');
  assert.equal(defaultRenderProvider('darwin'), 'libreoffice');
});

test('LibreOffice 轉檔使用獨立設定檔目錄，不會撞到已開啟的 LibreOffice', () => {
  const args = libreOfficeConvertArgs('C:\\decks\\a.pptx', 'C:\\work');
  assert.ok(args.includes('--headless'));
  assert.ok(args.includes('--nolockcheck'));
  assert.deepEqual(args.slice(args.indexOf('--convert-to'), args.indexOf('--convert-to') + 2), ['--convert-to', 'pdf']);
  assert.deepEqual(args.slice(args.indexOf('--outdir'), args.indexOf('--outdir') + 2), ['--outdir', 'C:\\work']);
  assert.equal(args.at(-1), 'C:\\decks\\a.pptx');
  assert.ok(args.some((item) => /^-env:UserInstallation=file:\/\/\/.*profile$/u.test(item)), args.join(' '));
});

test('逐頁輸出固定 1920×1080 且檔名可預期', () => {
  const args = pdfToPpmArgs('deck.pdf', 7, 'out/slide-7');
  assert.ok(args.includes('-singlefile'));
  assert.deepEqual(args.slice(args.indexOf('-f'), args.indexOf('-f') + 2), ['-f', '7']);
  assert.deepEqual(args.slice(args.indexOf('-l'), args.indexOf('-l') + 2), ['-l', '7']);
  assert.deepEqual(args.slice(args.indexOf('-scale-to-x'), args.indexOf('-scale-to-x') + 2), ['-scale-to-x', '1920']);
  assert.deepEqual(args.slice(args.indexOf('-scale-to-y'), args.indexOf('-scale-to-y') + 2), ['-scale-to-y', '1080']);
  assert.deepEqual(args.slice(-2), ['deck.pdf', 'out/slide-7']);
});

test('缺少 LibreOffice 或 poppler 時，doctor 給出安裝命令而不是崩潰', async () => {
  const status = await checkRenderer(libreOfficeConfig());
  assert.equal(status.available, false);
  assert.equal(status.provider, 'libreoffice');
  assert.equal(status.textFitInspected, false);
  assert.equal(status.nextSteps.length, 2);
  assert.ok(status.nextSteps.some((step) => step.includes('soffice')));
  assert.ok(status.nextSteps.some((step) => step.includes('pdftoppm')));
});

test('缺少 LibreOffice 時 render 直接失敗，不會產出半套投影片', async () => {
  await assert.rejects(
    () => renderDeck(libreOfficeConfig(), { slides: [{}] }),
    /找不到 LibreOffice/u,
  );
});

test('LibreOffice renderer 明確標示沒有做版面溢出檢查', async () => {
  const status = await checkRenderer(libreOfficeConfig());
  assert.equal(status.textFitInspected, false);
});

test('不支援的 renderProvider 在載入設定時就被擋下', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codereel-renderer-'));
  context.after(async () => await fs.rm(temporaryRoot, { recursive: true, force: true }));
  const repo = path.join(temporaryRoot, 'source-repo');
  const destination = path.join(temporaryRoot, 'codereel.config.json');
  await fs.mkdir(repo, { recursive: true });

  await initializeConfig({
    sourceTemplate: path.join(projectRoot, 'codereel.config.example.json'),
    destination,
    repoPath: repo,
  });
  assert.equal((await readJson(destination)).slides.renderProvider, defaultRenderProvider());

  const config = await readJson(destination);
  config.slides.renderProvider = 'keynote';
  await writeJsonAtomic(destination, config);
  await assert.rejects(() => loadConfig(destination), /不支援的 slides\.renderProvider/u);
});
