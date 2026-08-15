import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateStore } from './state.mjs';
import { assertRepoReadable } from './config.mjs';
import { buildSourceBundle, fallbackSourceSelection, saveScanArtifacts, scanRepository } from './repo-scan.mjs';
import { coursePlanJsonSchema, coursePlanMessages, sourceSelectionJsonSchema, sourceSelectionMessages } from './prompts.mjs';
import { createGenerationConfig, loadFixtureSelection, requestJson, resolveLlmModel } from './llm.mjs';
import { normalizeCoursePlanCommandPlacement, savePlanArtifacts, validateAndEnrichEvidence, validateCoursePlanShape, validateSelection } from './plan.mjs';
import { buildDeck } from './deck.mjs';
import { prepareNarration } from './narration.mjs';
import { renderDeck } from './render.mjs';
import { synthesizeNarration } from './tts.mjs';
import { buildVideo, probeMedia } from './media.mjs';
import { runQa } from './qa.mjs';
import { ensureDir, findCommand, isPathInside, nowIso, pathExists, readJson, runProcess, sha256, sha256File, stableStringify, writeTextAtomic } from './utils.mjs';

const stageLabels = {
  scan: '掃描 repo', plan: '建立證據與課程', deck: '產生 PPTX', narration: '抽取與正規化講稿',
  render: 'PowerPoint 逐頁渲染', speech: '逐頁配音', video: '逐頁影片與合成', qa: '品質檢查',
};
const PIPELINE_REVISION = 4;
const libDirectory = fileURLToPath(new URL('./', import.meta.url));

async function implementationHash(files) {
  const hashes = [];
  for (const file of files) hashes.push(await sha256File(path.resolve(libDirectory, file)));
  return sha256(hashes.join(':'));
}

function stageFingerprint(stage, payload) {
  return sha256(stableStringify({ pipelineRevision: PIPELINE_REVISION, stage, payload }));
}

async function logEvent(config, event) {
  await ensureDir(config.paths.logs);
  const file = path.join(config.paths.logs, 'events.jsonl');
  await fs.appendFile(file, `${JSON.stringify({ at: nowIso(), ...event })}\n`, 'utf8');
}

async function executeStage({ config, state, name, fingerprint, outputs, mutableOutputs = [], force, run, reuse }) {
  if (!force && await state.canReuse(name, fingerprint, outputs, { mutableOutputs })) {
    try {
      const result = await reuse();
      console.log(`✓ ${stageLabels[name]}（快取）`);
      await logEvent(config, { stage: name, status: 'cache-hit', fingerprint });
      return result;
    } catch (error) {
      console.warn(`! ${stageLabels[name]}快取不完整，將重新建立：${error.message}`);
      await logEvent(config, { stage: name, status: 'cache-invalid', fingerprint, error: error.message });
    }
  }
  console.log(`→ ${stageLabels[name]}`);
  await state.start(name, fingerprint);
  await logEvent(config, { stage: name, status: 'started', fingerprint });
  const stageStartedAt = Date.now();
  const heartbeat = setInterval(() => {
    const elapsedSeconds = Math.max(1, Math.round((Date.now() - stageStartedAt) / 1000));
    console.log(`… ${stageLabels[name]}仍在進行（${elapsedSeconds} 秒）`);
  }, 30000);
  heartbeat.unref();
  try {
    const result = await run();
    await state.succeed(name, outputs, result?.metadata || {});
    await logEvent(config, { stage: name, status: 'succeeded', fingerprint });
    console.log(`✓ ${stageLabels[name]}`);
    return result;
  } catch (error) {
    await state.fail(name, error);
    await logEvent(config, { stage: name, status: 'failed', fingerprint, error: error.message });
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

async function prepareWorkspace(config) {
  await assertRepoReadable(config);
  const outputRoot = path.resolve(config.outputRoot);
  await ensureDir(outputRoot);
  const rootStat = await fs.lstat(outputRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`outputRoot 必須是實體資料夾，不可為連結或 junction：${outputRoot}`);
  const outputReal = await fs.realpath(outputRoot);
  const repoReal = await fs.realpath(config.repoPath);
  const prospectiveRunReal = path.resolve(outputReal, path.relative(outputRoot, path.resolve(config.runRoot)));
  const prospectiveCacheReal = path.resolve(outputReal, path.relative(outputRoot, path.resolve(config.cacheRoot)));
  for (const candidate of [prospectiveRunReal, prospectiveCacheReal]) {
    if (isPathInside(repoReal, candidate) || isPathInside(candidate, repoReal)) {
      throw new Error(`來源 repo 與輸出／快取的實際路徑不可互相包含：${candidate}`);
    }
  }
  const directories = [
    config.runRoot, config.paths.logs, config.paths.evidence, config.paths.intermediate,
    config.paths.deck, config.paths.slides, config.paths.audio, config.paths.ssml,
    config.paths.video, config.paths.segments, config.paths.qa, config.cacheRoot,
    path.join(config.cacheRoot, 'audio'),
  ];
  for (const directory of directories) {
    const target = path.resolve(directory);
    if (!isPathInside(outputRoot, target)) throw new Error(`輸出路徑超出 outputRoot：${target}`);
    const relative = path.relative(outputRoot, target);
    let cursor = outputRoot;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      const before = await fs.lstat(cursor).catch(() => null);
      if (!before) await fs.mkdir(cursor);
      const stat = await fs.lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`輸出路徑不可包含連結或 junction：${cursor}`);
      const canonical = await fs.realpath(cursor);
      if (!isPathInside(outputReal, canonical)) throw new Error(`輸出路徑逃離 outputRoot：${cursor}`);
    }
  }
}

async function assertNonemptyFile(file, minimumBytes = 1) {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile() || stat.size < minimumBytes) throw new Error(`輸出不存在或不完整：${file}`);
}

export async function reuseRenderedDeck(config, expectedSlides) {
  const [render, overflow] = await Promise.all([
    readJson(config.paths.renderReport),
    readJson(config.paths.overflowReport),
  ]);
  if (render.slides !== expectedSlides || render.width !== 1920 || render.height !== 1080) {
    throw new Error(`渲染報告規格 ${render.slides} 頁、${render.width}×${render.height}，預期 ${expectedSlides} 頁、1920×1080`);
  }
  const names = await fs.readdir(config.paths.slides);
  const actual = names.filter((name) => /^slide-\d+\.png$/u.test(name)).sort();
  const expected = Array.from({ length: expectedSlides }, (_, index) => `slide-${index + 1}.png`).sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error(`渲染 PNG 頁面集合不符：收到 ${actual.join(', ') || '無'}`);
  }
  const [ffmpeg, ffprobe] = await Promise.all([findCommand('ffmpeg'), findCommand('ffprobe')]);
  if (!ffmpeg || !ffprobe) throw new Error('驗證渲染快取需要 ffmpeg 與 ffprobe。');
  for (let slide = 1; slide <= expectedSlides; slide += 1) {
    const file = path.join(config.paths.slides, `slide-${slide}.png`);
    const stat = await fs.lstat(file).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error(`渲染 PNG 不存在或不是一般檔案：${file}`);
    const probe = await probeMedia(file, ffprobe);
    const stream = probe.streams?.find((item) => item.codec_type === 'video');
    if (!stream || stream.width !== 1920 || stream.height !== 1080) {
      throw new Error(`第 ${slide} 頁 PNG 規格為 ${stream?.width || 0}×${stream?.height || 0}，預期 1920×1080`);
    }
    await runProcess(ffmpeg, [
      '-v', 'error', '-i', file, '-frames:v', '1', '-f', 'null', os.platform() === 'win32' ? 'NUL' : '/dev/null',
    ], { timeoutMs: 30000 });
  }
  return { render, overflow };
}

async function reuseAudioManifest(file) {
  const manifest = await readJson(file);
  if (!Array.isArray(manifest.slides) || manifest.slides.length === 0) throw new Error('音訊 manifest 沒有逐頁資料。');
  for (const item of manifest.slides) {
    await assertNonemptyFile(item.output, 1024);
    if (!item.sha256 || await sha256File(item.output) !== item.sha256) throw new Error(`音訊 hash 不符：${item.output}`);
    const probe = await probeMedia(item.output);
    if (!(Number(probe.format?.duration) > 0) || !probe.streams?.some((stream) => stream.codec_type === 'audio')) {
      throw new Error(`音訊無法解碼：${item.output}`);
    }
  }
  return manifest;
}

async function reuseVideoManifest(config) {
  const manifest = await readJson(config.paths.videoManifest);
  const required = [config.paths.finalVideo, config.paths.subtitles, config.paths.webvtt, config.paths.chapters];
  for (const file of required) await assertNonemptyFile(file);
  if (!Array.isArray(manifest.chapters) || manifest.chapters.length === 0) throw new Error('影片 manifest 沒有逐頁章節。');
  for (const chapter of manifest.chapters) {
    await assertNonemptyFile(chapter.segment);
    const probe = await probeMedia(chapter.segment);
    if (!(Number(probe.format?.duration) > 0) || !probe.streams?.some((stream) => stream.codec_type === 'video')) {
      throw new Error(`場景影片無法解碼：${chapter.segment}`);
    }
  }
  return manifest;
}

async function reuseQaReport(config) {
  const report = await readJson(config.paths.qaReport);
  if (report.passed !== true) throw new Error('既有 QA report 未通過。');
  for (const frame of report.sampleFrames || []) await assertNonemptyFile(frame);
  if (!Array.isArray(report.sampleFrames) || report.sampleFrames.length !== 3) throw new Error('QA sample frames 不完整。');
  return report;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function acquireRunLock(config, target) {
  const lockFile = path.join(config.runRoot, '.codereel.lock');
  const token = crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockFile, 'wx');
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, token, target, startedAt: nowIso(), configPath: config.configPath }, null, 2)}\n`, 'utf8');
      } finally {
        await handle.close();
      }
      return async () => {
        const current = await readJson(lockFile).catch(() => null);
        if (current?.token === token) await fs.rm(lockFile, { force: true });
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await readJson(lockFile).catch(() => null);
      if (processIsAlive(Number(existing?.pid))) {
        throw new Error(`已有 CodeReel 工作正在使用此輸出：PID ${existing.pid}，開始於 ${existing.startedAt || '未知時間'}`);
      }
      const stale = `${lockFile}.${process.pid}.${crypto.randomUUID()}.stale`;
      try {
        await fs.rename(lockFile, stale);
        await fs.rm(stale, { force: true });
      } catch (renameError) {
        if (attempt === 1) throw new Error(`無法清理失效的執行鎖：${lockFile}（${renameError.message}）`);
      }
    }
  }
  throw new Error(`無法取得執行鎖：${lockFile}`);
}

async function runPipelineUnlocked(config, options = {}) {
  const { target = 'run', force = false, approvedEgressDigest = '', overwriteDeckEdits = false } = options;
  const state = await new StateStore(config.paths.state).load();
  let resolvedModel;
  try {
    resolvedModel = await resolveLlmModel(config);
  } catch (error) {
    const cachedPlan = await readJson(config.paths.coursePlan).catch(() => null);
    if (!cachedPlan?.generation?.resolvedModel) throw error;
    resolvedModel = cachedPlan.generation.resolvedModel;
    console.warn(`! 無法重新查詢本機模型，暫用先前記錄：${resolvedModel}`);
  }

  const scanCodeHash = await implementationHash(['repo-scan.mjs', 'utils.mjs', 'config.mjs']);
  const scanFingerprint = stageFingerprint('scan', { repoPath: config.repoPath, scan: config.scan, scanCodeHash });
  const manifest = await executeStage({
    config, state, name: 'scan', fingerprint: scanFingerprint,
    outputs: [config.paths.repoManifest], force: true,
    run: async () => {
      const value = await scanRepository(config);
      await saveScanArtifacts(config, value);
      return value;
    },
    reuse: async () => await readJson(config.paths.repoManifest),
  });

  const manifestHash = sha256(stableStringify({
    repoPath: manifest.repoPath,
    git: manifest.git,
    files: manifest.files,
    skipped: manifest.skipped,
    limits: manifest.limits,
  }));
  const fixturePlanHash = config.llm.provider === 'fixture' ? await sha256File(config.llm.fixturePlan) : null;
  const generationConfig = config.llm.provider === 'fixture'
    ? config
    : createGenerationConfig(config, resolvedModel);
  const contentPreflight = {
    ttsProvider: config.tts.provider,
    estimatedCharactersPerMinute: config.tts.estimatedCharactersPerMinute,
    preRollMs: config.video.preRollMs,
    tailPaddingMs: config.video.tailPaddingMs,
  };
  const planCodeHash = await implementationHash(['plan.mjs', 'prompts.mjs', 'llm.mjs', 'repo-scan.mjs']);
  const planFingerprint = stageFingerprint('plan', { manifestHash, llm: config.llm, resolvedModel, fixturePlanHash, project: config.project, contentPreflight, planCodeHash });
  const plan = await executeStage({
    config, state, name: 'plan', fingerprint: planFingerprint,
    outputs: [config.paths.coursePlan, config.paths.evidenceManifest, config.paths.sourceBundle], force,
    run: async () => {
      let selectedPaths;
      if (config.llm.provider === 'fixture') {
        selectedPaths = await loadFixtureSelection(config, manifest);
      } else {
        try {
          const selection = await requestJson(
            sourceSelectionMessages(manifest, generationConfig),
            generationConfig,
            (value) => validateSelection(value, manifest, config.llm.maxSelectedFiles),
            sourceSelectionJsonSchema(config.llm.maxSelectedFiles),
          );
          selectedPaths = selection.value.selectedPaths.map((item) => String(item).replaceAll('\\', '/'));
        } catch (error) {
          console.warn(`! LLM 檔案選擇失敗，改用確定性排序：${error.message}`);
          selectedPaths = fallbackSourceSelection(manifest, config.llm.maxSelectedFiles);
        }
      }
      const bundle = await buildSourceBundle(generationConfig, manifest, selectedPaths);
      await writeTextAtomic(config.paths.sourceBundle, bundle.text);
      let enriched;
      const response = await requestJson(
        coursePlanMessages({ manifest, bundle, config: generationConfig }),
        generationConfig,
        async (value) => {
          const normalized = normalizeCoursePlanCommandPlacement(value, config);
          validateCoursePlanShape(normalized, config);
          enriched = await validateAndEnrichEvidence(normalized, config, manifest);
        },
        coursePlanJsonSchema(config, bundle.used.map((item) => item.path)),
      );
      enriched.plan.generation = { llmProvider: config.llm.provider, resolvedModel: response.model || resolvedModel, pipelineRevision: PIPELINE_REVISION };
      await savePlanArtifacts(config, enriched);
      return enriched.plan;
    },
    reuse: async () => await readJson(config.paths.coursePlan),
  });
  if (target === 'analyze') return { manifest, plan, state: state.state };

  const themeHash = await sha256File(config.slides.themeFile);
  const deckCodeHash = await implementationHash(['deck.mjs', '../../package-lock.json']);
  const deckFingerprint = stageFingerprint('deck', { plan, slides: config.slides, themeHash, deckCodeHash });
  const previousDeckStage = state.state.stages.deck;
  const deckBaseline = previousDeckStage?.status === 'succeeded' ? previousDeckStage : previousDeckStage?.lastSucceeded;
  const previousDeckRecord = deckBaseline?.outputRecords?.find((item) => item.path === config.paths.deckFile);
  const deckExists = await pathExists(config.paths.deckFile);
  const deckWasEdited = Boolean(deckExists && (!previousDeckRecord || await sha256File(config.paths.deckFile) !== previousDeckRecord.sha256));
  const deckNeedsRegeneration = force || deckBaseline?.fingerprint !== deckFingerprint || !previousDeckRecord;
  if (deckWasEdited && deckNeedsRegeneration && !overwriteDeckEdits) {
    throw new Error('偵測到 PPTX／speaker notes 的人工修改，且來源或模板也已變更。為避免覆寫，已停止；請先保存合併，或明確加入 --overwrite-deck-edits（系統會先備份）。');
  }
  if (deckWasEdited && deckNeedsRegeneration && overwriteDeckEdits) {
    const backupDirectory = path.join(config.paths.deck, 'backups');
    await ensureDir(backupDirectory);
    const backup = path.join(backupDirectory, `${config.projectId}-人工編輯-${nowIso().replace(/[:.]/gu, '-')}.pptx`);
    await fs.copyFile(config.paths.deckFile, backup, fs.constants.COPYFILE_EXCL);
    console.warn(`! 已備份人工編輯的 PPTX：${backup}`);
  }
  await executeStage({
    config, state, name: 'deck', fingerprint: deckFingerprint,
    outputs: [config.paths.deckFile, config.paths.deckManifest], force,
    mutableOutputs: [config.paths.deckFile],
    run: async () => await buildDeck(config, plan),
    reuse: async () => await readJson(config.paths.deckManifest),
  });

  const narrationCodeHash = await implementationHash(['narration.mjs']);
  const narrationFingerprint = stageFingerprint('narration', {
    deckHash: await sha256File(config.paths.deckFile),
    pronunciation: config.tts.pronunciation,
    contentPreflight,
    projectTargetMinutes: config.project.targetMinutes,
    narrationCodeHash,
  });
  const narration = await executeStage({
    config, state, name: 'narration', fingerprint: narrationFingerprint,
    outputs: [config.paths.narrationDisplay, config.paths.narrationTts, config.paths.pronunciationAudit], force,
    run: async () => await prepareNarration(config, plan),
    reuse: async () => ({ display: await readJson(config.paths.narrationDisplay), tts: await readJson(config.paths.narrationTts) }),
  });

  const renderCodeHash = await implementationHash(['render.mjs', '../../scripts/render-powerpoint.ps1', '../../scripts/inspect-powerpoint.ps1']);
  const renderFingerprint = stageFingerprint('render', { deckHash: await sha256File(config.paths.deckFile), render: config.slides.renderProvider, renderCodeHash });
  const renderedSlideOutputs = Array.from(
    { length: plan.slides.length },
    (_, index) => path.join(config.paths.slides, `slide-${index + 1}.png`),
  );
  await executeStage({
    config, state, name: 'render', fingerprint: renderFingerprint,
    outputs: [config.paths.renderReport, config.paths.overflowReport, ...renderedSlideOutputs], force,
    run: async () => await renderDeck(config, plan),
    reuse: async () => await reuseRenderedDeck(config, plan.slides.length),
  });
  if (target === 'build') return { manifest, plan, narration, state: state.state };

  const speechCodeHash = await implementationHash(['tts.mjs', 'narration.mjs']);
  const speechFingerprint = stageFingerprint('speech', { narration: narration.tts, tts: config.tts, speechCodeHash });
  const audioManifestPath = path.join(config.paths.audio, 'audio-manifest.json');
  const audio = await executeStage({
    config, state, name: 'speech', fingerprint: speechFingerprint,
    outputs: [audioManifestPath], force,
    run: async () => await synthesizeNarration(config, narration.tts, { approvedEgressDigest }),
    reuse: async () => await reuseAudioManifest(audioManifestPath),
  });

  const renderedSlideHashes = [];
  for (let slide = 1; slide <= plan.slides.length; slide += 1) {
    renderedSlideHashes.push(await sha256File(path.join(config.paths.slides, `slide-${slide}.png`)));
  }
  const videoCodeHash = await implementationHash(['media.mjs']);
  const videoFingerprint = stageFingerprint('video', { deck: renderFingerprint, renderedSlideHashes, audio, video: config.video, videoCodeHash });
  const video = await executeStage({
    config, state, name: 'video', fingerprint: videoFingerprint,
    outputs: [config.paths.finalVideo, config.paths.videoManifest, config.paths.subtitles, config.paths.webvtt, config.paths.chapters], force,
    run: async () => await buildVideo(config, plan, audio),
    reuse: async () => await reuseVideoManifest(config),
  });

  const qaCodeHash = await implementationHash(['qa.mjs', 'media.mjs', 'tts.mjs', '../../scripts/inspect-powerpoint.ps1']);
  const licenseStatus = Object.fromEntries(await Promise.all(
    ['LICENSE', 'LICENSE.md', 'COPYING'].map(async (name) => [name, await pathExists(path.join(config.repoPath, name))]),
  ));
  const qaFingerprint = stageFingerprint('qa', {
    videoFingerprint,
    evidence: await sha256File(config.paths.evidenceManifest),
    manifestHash,
    licenseStatus,
    project: config.project,
    videoQa: config.video,
    tts: { provider: config.tts.provider, voice: config.tts.voice, rate: config.tts.rate },
    qaCodeHash,
  });
  const qa = await executeStage({
    config, state, name: 'qa', fingerprint: qaFingerprint,
    outputs: [
      config.paths.qaReport,
      path.join(config.paths.qa, 'video-samples', 'sample-01.png'),
      path.join(config.paths.qa, 'video-samples', 'sample-02.png'),
      path.join(config.paths.qa, 'video-samples', 'sample-03.png'),
    ], force,
    run: async () => await runQa(config),
    reuse: async () => await reuseQaReport(config),
  });
  return { manifest, plan, narration, audio, video, qa, state: state.state };
}

export async function runPipeline(config, options = {}) {
  return await withPipelineLock(config, options.target || 'run', async () => await runPipelineUnlocked(config, options));
}

export async function withPipelineLock(config, target, action) {
  await prepareWorkspace(config);
  const releaseLock = await acquireRunLock(config, target);
  try {
    return await action();
  } finally {
    await releaseLock();
  }
}

export async function readPipelineStatus(config) {
  const state = await new StateStore(config.paths.state).load();
  return state.state;
}
