import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import PptxGenJS from 'pptxgenjs';
import { extractPptxNarration, makeSpokenText } from '../src/lib/narration.mjs';

test('顯示稿與 TTS 稿分離，縮寫與底線只改 spoken', () => {
  const display = '呼叫 RAG_API 後回傳結果。';
  const result = makeSpokenText(display, {
    spellAcronyms: true,
    underscoresAsPause: true,
    replacements: [{ from: 'RAG', to: 'R A G' }, { from: 'API', to: 'A P I' }],
  });
  assert.equal(display, '呼叫 RAG_API 後回傳結果。');
  assert.equal(result.spoken, '呼叫 R A G，A P I 後回傳結果。');
  assert.ok(result.audit.some((entry) => entry.rule === 'underscore'));
});

test('speaker notes 中的 literal XML entity 不會被二次解碼', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codereel-notes-'));
  context.after(async () => await fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'notes.pptx');
  const marker = 'entity-regression';
  const pptx = new PptxGenJS();
  const slide = pptx.addSlide();
  slide.addText('測試', { x: 1, y: 1, w: 2, h: 1 });
  slide.addNotes(`技術字串 &#65; 不應變成字母\n\n[CodeReelSources:${marker}]\nREADME.md:1-1`);
  await pptx.writeFile({ fileName: file });

  const result = await extractPptxNarration(file, [{ slide: 1, marker }]);
  assert.equal(result[0].display, '技術字串 &#65; 不應變成字母');
});
