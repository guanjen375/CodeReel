import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/lib/config.mjs';
import { scanRepository } from '../src/lib/repo-scan.mjs';
import { validateAndEnrichEvidence, validateCoursePlanShape } from '../src/lib/plan.mjs';
import { readJson } from '../src/lib/utils.mjs';

test('fixture 課程的每頁證據與逐字命令都可驗證', async () => {
  const config = await loadConfig('./examples/demo.config.json');
  const plan = await readJson('./examples/demo-course-plan.json');
  const manifest = await scanRepository(config);
  validateCoursePlanShape(plan, config);
  const enriched = await validateAndEnrichEvidence(plan, config, manifest);
  assert.equal(enriched.evidenceManifest.coverage.percent, 100);
  assert.equal(enriched.plan.slides.length, 6);
  assert.ok(enriched.evidenceManifest.evidence.every((item) => item.excerptSha256.length === 64));
});

test('模型發明、不在證據中的命令會被拒絕', async () => {
  const config = await loadConfig('./examples/demo.config.json');
  const plan = structuredClone(await readJson('./examples/demo-course-plan.json'));
  plan.slides[2].code.text = 'npm run invented-command';
  const manifest = await scanRepository(config);
  await assert.rejects(() => validateAndEnrichEvidence(plan, config, manifest), /不是證據範圍中的逐字內容/u);
});
