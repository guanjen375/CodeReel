import test from 'node:test';
import assert from 'node:assert/strict';
import { displayWidth, fitFontSize, softWrap } from '../src/lib/deck.mjs';

const codePanel = { widthInches: 5.28, heightInches: 3.7, basePt: 15, minPt: 8, unitRatio: 0.6, paraSpacePt: 5, avoidWrap: true };

test('全形字元佔兩個寬度單位', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('繁體中文'), 8);
  assert.equal(displayWidth('知識庫不要 commit'), 10 + 7);
  assert.equal(displayWidth(''), 0);
});

test('短命令維持原字級，長命令才縮小', () => {
  assert.equal(fitFontSize([' 1  npm run demo'], codePanel), 15);
  const long = fitFontSize([' 1  python3 -m pip install --user --break-system-packages -r requirements.txt'], codePanel);
  assert.ok(long < 15, `預期縮小，實際 ${long}`);
  assert.ok(long >= 8);
});

test('字級不會低於下限，避免被 text-too-small 判定', () => {
  const extreme = fitFontSize([` 1  ${'x'.repeat(400)}`], codePanel);
  assert.equal(extreme, 8);
  const manyLines = fitFontSize(Array.from({ length: 12 }, (_, index) => ` ${index}  ${'y'.repeat(120)}`), codePanel);
  assert.ok(manyLines >= 8);
});

test('行數過多時依高度再縮一級', () => {
  const short = fitFontSize([' 1  npm test'], codePanel);
  const tall = fitFontSize(Array.from({ length: 12 }, (_, index) => ` ${index}  npm test`), codePanel);
  assert.ok(tall < short, `預期 ${tall} 小於 ${short}`);
});

test('自行折行後沒有任何一列超過寬度上限', () => {
  const lines = [
    ' 1  cd <CODETRAIL_REPO>                          # 1. 進 CodeTrail repo',
    ' 2  python3 -m pip install --user --break-system-packages -r requirements.txt',
    ' 3  請用工具 list_dir 看當前目錄結構，挑出 entry point、主要模組和測試目錄。',
  ];
  for (const limit of [12, 20, 40, 79]) {
    for (const row of softWrap(lines, limit)) {
      assert.ok(displayWidth(row) <= limit, `limit=${limit} 時出現 ${displayWidth(row)} 寬的列：${row}`);
    }
  }
});

test('折行不會遺失或新增內容，且優先斷在空白處', () => {
  const lines = [' 1  npm install --global @anthropic-ai/claude-code'];
  const rows = softWrap(lines, 24);
  assert.ok(rows.length > 1);
  assert.equal(
    rows.join('').replace(/\s+/gu, ''),
    lines.join('').replace(/\s+/gu, ''),
  );
  assert.ok(rows.slice(1).every((row) => row.startsWith('    ')), '續行需要縮排');
  assert.ok(rows[0].endsWith('install') || rows[0].endsWith('npm'), `預期斷在空白處，實際 ${rows[0]}`);
});

test('本來就夠短的行不會被動到', () => {
  const lines = [' 1  npm run demo', ' 2  npm test'];
  assert.deepEqual(softWrap(lines, 40), lines);
});
