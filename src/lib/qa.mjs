import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureDir, findCommand, pathExists, readJson, runProcess, writeJsonAtomic } from './utils.mjs';
import { probeMedia } from './media.mjs';
import { validateAudio } from './tts.mjs';

const forbiddenPhrases = ['建議講者', '講者可以', '本頁只抓', '本頁要', '這張投影片要', '剛接觸專案者應該'];
const commonSimplifiedCharacters = /[这为发应现进过还从将与会学术体务网数线码档处实认验启]/u;

function countMatching(names, pattern) {
  return names.filter((name) => pattern.test(name)).length;
}

export function validateSequentialSlideIds(label, items, expected, getId = (item) => item?.slide) {
  const ids = items.map((item) => getId(item));
  const wanted = Array.from({ length: expected }, (_, index) => index + 1);
  if (ids.length !== expected || ids.some((id) => !Number.isInteger(id)) || new Set(ids).size !== ids.length || wanted.some((id) => !ids.includes(id))) {
    return `${label} slide id 必須完整且唯一涵蓋 1–${expected}；收到 ${ids.join(', ') || '無'}`;
  }
  return null;
}

export function validateSlideFileSet(label, names, expected, pattern, canonicalName) {
  const matched = names.map((name) => ({ name, match: name.match(pattern) })).filter((item) => item.match);
  const ids = matched.map((item) => Number(item.match[1]));
  const wantedNames = Array.from({ length: expected }, (_, index) => canonicalName(index + 1));
  const actualNames = matched.map((item) => item.name);
  const idError = validateSequentialSlideIds(label, ids, expected, (id) => id);
  if (idError || wantedNames.some((name) => !actualNames.includes(name)) || actualNames.some((name) => !wantedNames.includes(name))) {
    return `${label} 檔案必須完整且唯一涵蓋 1–${expected}；收到 ${actualNames.join(', ') || '無'}`;
  }
  return null;
}

function rateNumber(value) {
  const [numerator, denominator = '1'] = String(value || '').split('/');
  const result = Number(numerator) / Number(denominator);
  return Number.isFinite(result) ? result : null;
}

export function parseSrt(text) {
  const cues = [];
  const malformed = [];
  const value = String(text).trim();
  if (!value) return { cues, malformed };
  const blocks = value.split(/\r?\n\r?\n/u);
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex];
    const lines = block.split(/\r?\n/u);
    const number = Number(lines[0]);
    const match = lines[1]?.match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})$/u);
    if (!Number.isInteger(number) || number !== blockIndex + 1 || !match || lines.length < 3 || !lines.slice(2).join('\n').trim()) {
      malformed.push({ block: blockIndex + 1, preview: block.slice(0, 160) });
      continue;
    }
    const toSeconds = (offset) => Number(match[offset]) * 3600 + Number(match[offset + 1]) * 60 + Number(match[offset + 2]) + Number(match[offset + 3]) / 1000;
    cues.push({ number, start: toSeconds(1), end: toSeconds(5), text: lines.slice(2).join('\n') });
  }
  return { cues, malformed };
}

async function extractVideoSamples(config, videoManifest) {
  const ffmpeg = await findCommand('ffmpeg');
  if (!ffmpeg) return [];
  const sampleDir = path.join(config.paths.qa, 'video-samples');
  await ensureDir(sampleDir);
  const chapters = videoManifest.chapters;
  const targets = [chapters[0], chapters[Math.floor(chapters.length / 2)], chapters.at(-1)].filter(Boolean);
  const outputs = [];
  for (let index = 0; index < targets.length; index += 1) {
    const at = targets[index].startSeconds + Math.min(1, targets[index].durationSeconds / 2);
    const output = path.join(sampleDir, `sample-${String(index + 1).padStart(2, '0')}.png`);
    await runProcess(ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error', '-ss', at.toFixed(3), '-i', config.paths.finalVideo,
      '-frames:v', '1', output,
    ], { timeoutMs: 120000 });
    outputs.push(output);
  }
  return outputs;
}

async function measureMeanVolume(file) {
  const ffmpeg = await findCommand('ffmpeg');
  if (!ffmpeg) throw new Error('音量 QA 需要 ffmpeg。');
  const result = await runProcess(ffmpeg, [
    '-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'volumedetect',
    '-f', 'null', os.platform() === 'win32' ? 'NUL' : '/dev/null',
  ], { allowFailure: true, timeoutMs: 120000 });
  const match = result.stderr.match(/mean_volume:\s*(-?inf|-?[0-9.]+)\s*dB/iu);
  if (!match) throw new Error(`無法量測音量：${file}`);
  return match[1].toLowerCase() === '-inf' ? Number.NEGATIVE_INFINITY : Number(match[1]);
}

async function measureLoudness(file, config) {
  const ffmpeg = await findCommand('ffmpeg');
  if (!ffmpeg) throw new Error('響度 QA 需要 ffmpeg。');
  const result = await runProcess(ffmpeg, [
    '-hide_banner', '-nostats', '-i', file, '-vn',
    '-af', `loudnorm=I=${config.video.integratedLufs}:TP=${config.video.truePeakDb}:LRA=11:print_format=json`,
    '-f', 'null', os.platform() === 'win32' ? 'NUL' : '/dev/null',
  ], { allowFailure: true, timeoutMs: 300000 });
  const match = result.stderr.match(/\{[\s\S]*?"input_i"[\s\S]*?"target_offset"[\s\S]*?\}/gu)?.at(-1);
  if (!match) throw new Error('無法解析最終影片響度。');
  const parsed = JSON.parse(match);
  return { integratedLufs: Number(parsed.input_i), truePeakDb: Number(parsed.input_tp) };
}

export async function runQa(config) {
  const failures = [];
  const warnings = [];
  const [plan, evidence, audio, video, render, overflow, display] = await Promise.all([
    readJson(config.paths.coursePlan),
    readJson(config.paths.evidenceManifest),
    readJson(path.join(config.paths.audio, 'audio-manifest.json')),
    readJson(config.paths.videoManifest),
    readJson(config.paths.renderReport),
    readJson(config.paths.overflowReport),
    readJson(config.paths.narrationDisplay),
  ]);
  const expected = plan.slides.length;
  const [webvtt, chapterText] = await Promise.all([
    fs.readFile(config.paths.webvtt, 'utf8').catch(() => null),
    fs.readFile(config.paths.chapters, 'utf8').catch(() => null),
  ]);
  if (webvtt === null) failures.push('缺少 WebVTT 字幕檔。');
  else if (!/^WEBVTT(?:\r?\n)/u.test(webvtt)) failures.push('WebVTT 字幕檔格式無效。');
  if (chapterText === null) failures.push('缺少章節文字檔。');
  else {
    const chapterLines = chapterText.split(/\r?\n/u).filter((line) => line.trim());
    if (chapterLines.length !== expected) failures.push(`章節文字檔有 ${chapterLines.length} 行，預期 ${expected}。`);
  }
  if (audio.provider !== config.tts.provider) failures.push(`音訊 manifest provider 為 ${audio.provider || 'missing'}，預期 ${config.tts.provider}。`);
  if (audio.voice !== config.tts.voice) failures.push(`音訊 manifest voice 為 ${audio.voice || 'missing'}，預期 ${config.tts.voice}。`);
  if (audio.rate !== config.tts.rate) failures.push(`音訊 manifest rate 為 ${audio.rate || 'missing'}，預期 ${config.tts.rate}。`);
  if (plan.slides[0]?.kind !== 'cover') failures.push('第一頁必須是 cover。');
  if (!plan.slides.some((slide) => slide.kind === 'agenda')) failures.push('課程缺少 agenda 頁。');
  if (!plan.slides.some((slide) => ['steps', 'code'].includes(slide.kind))) failures.push('課程缺少實際操作頁。');
  if (plan.slides.at(-1)?.kind !== 'summary') failures.push('最後一頁必須是 summary。');
  const slideFiles = await fs.readdir(config.paths.slides);
  const audioFiles = await fs.readdir(config.paths.audio);
  const segmentFiles = await fs.readdir(config.paths.segments);
  const counts = {
    plan: expected,
    notes: display.length,
    png: countMatching(slideFiles, /^slide-\d+\.png$/u),
    audio: countMatching(audioFiles, /^slide-\d+\.(?:mp3|wav)$/u),
    segments: countMatching(segmentFiles, /^slide-\d+\.mp4$/u),
    manifestChapters: video.chapters.length,
  };
  for (const [kind, count] of Object.entries(counts)) {
    if (count !== expected) failures.push(`${kind} 數量 ${count}，預期 ${expected}`);
  }
  for (const issue of [
    validateSequentialSlideIds('旁白', display, expected),
    validateSequentialSlideIds('音訊 manifest', audio.slides || [], expected),
    validateSequentialSlideIds('影片章節', video.chapters || [], expected),
    validateSlideFileSet('PNG', slideFiles, expected, /^slide-(\d+)\.png$/u, (id) => `slide-${id}.png`),
    validateSlideFileSet('音訊', audioFiles, expected, /^slide-(\d+)\.(?:mp3|wav)$/u, (id) => `slide-${String(id).padStart(3, '0')}.${config.tts.provider === 'azure' ? 'mp3' : 'wav'}`),
    validateSlideFileSet('場景', segmentFiles, expected, /^slide-(\d+)\.mp4$/u, (id) => `slide-${String(id).padStart(3, '0')}.mp4`),
  ]) if (issue) failures.push(issue);
  if (Array.isArray(video.chapters)) {
    for (let index = 0; index < Math.min(expected, video.chapters.length); index += 1) {
      if (video.chapters[index]?.slideId !== plan.slides[index]?.id) failures.push(`第 ${index + 1} 頁章節 slideId 與課程計畫不符。`);
    }
  }
  if (!render || render.width !== 1920 || render.height !== 1080 || render.slides !== expected) failures.push('投影片渲染規格或頁數不符。');
  if (!overflow.passed || overflow.issueCount > 0) failures.push(`版面溢出檢查有 ${overflow.issueCount} 個問題。`);
  else if (overflow.inspected === false) {
    warnings.push(`${overflow.provider || '目前的'} renderer 無法量測文字框，未執行版面溢出檢查；發布前請人工確認每頁文字沒有被裁切。`);
  }
  if (evidence.coverage.percent !== 100) failures.push(`逐頁來源引用覆蓋率只有 ${evidence.coverage.percent}%`);
  for (const entry of display) {
    if (!entry.display.trim()) failures.push(`第 ${entry.slide} 頁講稿為空。`);
    const proseCharacters = [...entry.display.replace(/\s/gu, '')].length;
    if (proseCharacters < 40 || proseCharacters > 260) failures.push(`第 ${entry.slide} 頁講稿 ${proseCharacters} 字，允許範圍為 40–260 字。`);
    if (commonSimplifiedCharacters.test(entry.display)) failures.push(`第 ${entry.slide} 頁講稿含常見簡體字。`);
    for (const phrase of forbiddenPhrases) if (entry.display.includes(phrase)) failures.push(`第 ${entry.slide} 頁旁白含禁詞「${phrase}」。`);
  }
  for (const item of audio.slides) {
    await validateAudio(item.output, item.slide, item.sha256).catch((error) => failures.push(error.message));
  }
  const audioLevels = [];
  let finalLoudness = null;
  if (config.tts.provider !== 'fixture') {
    for (const item of audio.slides) {
      const meanVolumeDb = await measureMeanVolume(item.output).catch((error) => {
        failures.push(error.message);
        return null;
      });
      audioLevels.push({ slide: item.slide, meanVolumeDb });
      if (meanVolumeDb === null || meanVolumeDb < -55) failures.push(`第 ${item.slide} 頁音訊過小或近乎靜音。`);
    }
  }
  const probe = await probeMedia(config.paths.finalVideo);
  const videoStream = probe.streams.find((stream) => stream.codec_type === 'video');
  const audioStream = probe.streams.find((stream) => stream.codec_type === 'audio');
  if (!videoStream || videoStream.width !== 1920 || videoStream.height !== 1080) failures.push('最終影片不是 1920×1080。');
  if (videoStream?.codec_name !== 'h264') failures.push(`最終影片 codec 為 ${videoStream?.codec_name || 'missing'}，預期 h264。`);
  if (videoStream?.pix_fmt !== 'yuv420p') failures.push(`最終影片 pixel format 為 ${videoStream?.pix_fmt || 'missing'}，預期 yuv420p。`);
  for (const [label, value] of [['r_frame_rate', videoStream?.r_frame_rate], ['avg_frame_rate', videoStream?.avg_frame_rate]]) {
    const rate = rateNumber(value);
    if (rate === null || Math.abs(rate - config.video.fps) > 0.01) failures.push(`最終影片 ${label} 為 ${value || 'missing'}，預期 ${config.video.fps} FPS。`);
  }
  if (audioStream?.codec_name !== 'aac') failures.push(`最終音訊 codec 為 ${audioStream?.codec_name || 'missing'}，預期 aac。`);
  const duration = Number(probe.format?.duration || 0);
  if (!(duration > 0)) failures.push('最終影片長度無效。');
  if (config.tts.provider !== 'fixture') {
    const targetSeconds = Number(config.project.targetMinutes) * 60;
    if (!(targetSeconds > 0) || duration < targetSeconds * 0.6 || duration > targetSeconds * 1.4) {
      failures.push(`最終影片 ${duration.toFixed(1)} 秒，超出目標 ${targetSeconds.toFixed(1)} 秒的 60%–140% 範圍。`);
    }
    finalLoudness = await measureLoudness(config.paths.finalVideo, config).catch((error) => {
      failures.push(error.message);
      return null;
    });
    if (finalLoudness && config.video.loudnessNormalization) {
      if (!Number.isFinite(finalLoudness.integratedLufs) || Math.abs(finalLoudness.integratedLufs - config.video.integratedLufs) > 2.5) {
        failures.push(`最終影片整合響度 ${finalLoudness.integratedLufs} LUFS，未接近 ${config.video.integratedLufs} LUFS。`);
      }
      if (!Number.isFinite(finalLoudness.truePeakDb) || finalLoudness.truePeakDb > config.video.truePeakDb + 0.5) {
        failures.push(`最終影片 true peak ${finalLoudness.truePeakDb} dBTP，高於允許值。`);
      }
    }
  }
  const parsedSrt = parseSrt(await fs.readFile(config.paths.subtitles, 'utf8'));
  const srt = parsedSrt.cues;
  if (parsedSrt.malformed.length) failures.push(`SRT 有 ${parsedSrt.malformed.length} 個格式錯誤區塊。`);
  if (!srt.length) failures.push('SRT 沒有有效字幕。');
  for (let index = 0; index < srt.length; index += 1) {
    const cue = srt[index];
    if (!(cue.end > cue.start)) failures.push(`SRT cue ${index + 1} 時間無效。`);
    if (index > 0 && cue.start < srt[index - 1].end - 0.001) failures.push(`SRT cue ${index + 1} 與前一段重疊。`);
    if (cue.end > duration + 0.05) failures.push(`SRT cue ${index + 1} 超出影片長度。`);
    if (cue.text.split(/\r?\n/u).length > 2) failures.push(`SRT cue ${index + 1} 超過兩行。`);
  }
  if (plan.repo.dirty === true) warnings.push('來源 repo 有未提交變更；manifest 已記錄 dirty=true。');
  if (plan.repo.dirty === null) warnings.push('為保持來源唯讀，未執行 git status；發布前請自行確認工作樹狀態。');
  const licenseCandidates = ['LICENSE', 'LICENSE.md', 'COPYING'];
  if (!(await Promise.all(licenseCandidates.map((name) => pathExists(path.join(config.repoPath, name))))).some(Boolean)) {
    warnings.push('未偵測到根目錄授權檔；商用輸出前需確認有權重製程式碼與畫面。');
  }
  if (config.tts.provider === 'azure' && !config.tts.licenseRecord) {
    warnings.push('未在設定記錄正式語音方案／授權依據；發布前請補上 tts.licenseRecord。');
  }
  if (config.tts.provider === 'fixture') warnings.push('示例使用無聲 fixture 音訊，不可作正式成品。');
  warnings.push('自動檢查只能確認逐頁引用與行號存在；claim 與敘述是否由 excerpt 語意支持，發布前仍需人工逐項核對。');
  const sampleFrames = await extractVideoSamples(config, video);
  const report = {
    schemaVersion: 1,
    passed: failures.length === 0,
    failures,
    warnings,
    counts,
    slideReferenceCoveragePercent: evidence.coverage.percent,
    manualClaimReviewRequired: true,
    video: {
      path: config.paths.finalVideo,
      durationSeconds: duration,
      width: videoStream?.width,
      height: videoStream?.height,
      videoCodec: videoStream?.codec_name,
      pixelFormat: videoStream?.pix_fmt,
      audioCodec: audioStream?.codec_name,
      loudness: finalLoudness,
    },
    audioLevels,
    subtitles: { cues: srt.length, path: config.paths.subtitles },
    sampleFrames,
    manualVisualReviewRequired: true,
    automatedReleaseProfilePassed: failures.length === 0 && config.tts.provider !== 'fixture',
    generatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(config.paths.qaReport, report);
  if (!report.passed) throw new Error(`QA 未通過：\n- ${failures.join('\n- ')}`);
  return report;
}
