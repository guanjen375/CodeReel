import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { copyFileAtomic, ensureDir, findCommand, isPathInside, pathExists, readJson, replaceFileAtomic, runProcess, secondsToClock, sha256, sha256File, writeJsonAtomic, writeTextAtomic } from './utils.mjs';

async function mediaTools() {
  const [ffmpeg, ffprobe] = await Promise.all([findCommand('ffmpeg'), findCommand('ffprobe')]);
  if (!ffmpeg || !ffprobe) throw new Error('需要 ffmpeg 與 ffprobe。');
  return { ffmpeg, ffprobe };
}

export async function probeMedia(file, ffprobePath = null) {
  const ffprobe = ffprobePath || (await mediaTools()).ffprobe;
  const result = await runProcess(ffprobe, [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', file,
  ], { timeoutMs: 60000 });
  return JSON.parse(result.stdout);
}

function durationFromProbe(probe) {
  const value = Number(probe?.format?.duration);
  if (!Number.isFinite(value)) throw new Error('ffprobe 沒有回傳有效 duration。');
  return value;
}

function temporaryMediaPath(target, label = 'partial') {
  const extension = path.extname(target);
  const stem = target.slice(0, -extension.length);
  return `${stem}.${process.pid}.${crypto.randomUUID()}.${label}${extension}`;
}

async function assertPlayableMedia(file, tools) {
  const probe = await probeMedia(file, tools.ffprobe);
  const duration = durationFromProbe(probe);
  if (!(duration > 0)) throw new Error(`媒體長度無效：${file}`);
  return probe;
}

function frameRate(value) {
  const [numerator, denominator = '1'] = String(value || '').split('/');
  const result = Number(numerator) / Number(denominator);
  return Number.isFinite(result) ? result : null;
}

async function inspectSegmentOutput(file, tools, config) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error(`場景不是有效的一般檔案：${file}`);
  const probe = await probeMedia(file, tools.ffprobe);
  const durationSeconds = durationFromProbe(probe);
  const video = probe.streams?.find((stream) => stream.codec_type === 'video');
  const audio = probe.streams?.find((stream) => stream.codec_type === 'audio');
  if (!video || video.codec_name !== 'h264' || video.pix_fmt !== 'yuv420p' || video.width !== 1920 || video.height !== 1080) {
    throw new Error(`場景影像規格不符：${file}`);
  }
  for (const value of [video.r_frame_rate, video.avg_frame_rate]) {
    const actual = frameRate(value);
    if (actual === null || Math.abs(actual - config.video.fps) > 0.01) throw new Error(`場景 FPS 不符：${file}`);
  }
  if (!audio || audio.codec_name !== 'aac') throw new Error(`場景音訊規格不符：${file}`);
  return {
    outputSha256: await sha256File(file),
    bytes: stat.size,
    durationSeconds: Number(durationSeconds.toFixed(6)),
    videoStream: {
      codec: video.codec_name,
      pixelFormat: video.pix_fmt,
      width: video.width,
      height: video.height,
      rFrameRate: video.r_frame_rate,
      avgFrameRate: video.avg_frame_rate,
    },
    audioStream: { codec: audio.codec_name },
  };
}

export async function validateSegmentForReuse(file, sidecar, config, toolsOverride = null) {
  if (!sidecar?.outputSha256 || !Number.isInteger(sidecar.bytes) || !(sidecar.durationSeconds > 0) || !sidecar.videoStream || !sidecar.audioStream) {
    throw new Error(`場景 sidecar 缺少輸出驗證資料：${file}`);
  }
  const tools = toolsOverride || await mediaTools();
  const actual = await inspectSegmentOutput(file, tools, config);
  if (actual.outputSha256 !== sidecar.outputSha256 || actual.bytes !== sidecar.bytes) throw new Error(`場景輸出 hash 或大小不符：${file}`);
  if (Math.abs(actual.durationSeconds - sidecar.durationSeconds) > 0.01) throw new Error(`場景輸出時長不符：${file}`);
  if (!(sidecar.targetDuration > 0) || Math.abs(actual.durationSeconds - sidecar.targetDuration) > (1 / config.video.fps + 0.05)) {
    throw new Error(`場景輸出時長未貼合預期：${file}`);
  }
  if (JSON.stringify(actual.videoStream) !== JSON.stringify(sidecar.videoStream) || JSON.stringify(actual.audioStream) !== JSON.stringify(sidecar.audioStream)) {
    throw new Error(`場景輸出串流規格與 sidecar 不符：${file}`);
  }
  return actual;
}

export async function cleanupStaleSegments(config, expectedSlides) {
  const runRoot = path.resolve(config.runRoot || path.dirname(config.paths.video));
  const directory = path.resolve(config.paths.segments);
  if (!isPathInside(runRoot, directory)) throw new Error(`拒絕清理 runRoot 外的場景目錄：${directory}`);
  const rootStat = await fs.lstat(runRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`runRoot 必須是實體資料夾：${runRoot}`);
  let cursor = runRoot;
  for (const part of path.relative(runRoot, directory).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = await fs.lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`場景目錄不可包含 reparse point：${cursor}`);
  }
  const [rootReal, directoryReal] = await Promise.all([fs.realpath(runRoot), fs.realpath(directory)]);
  if (!isPathInside(rootReal, directoryReal)) throw new Error(`場景目錄實際路徑逃離 runRoot：${directory}`);
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const match = entry.name.match(/^slide-(\d+)\.mp4(?:\.json)?$/u);
    if (!match || (Number(match[1]) >= 1 && Number(match[1]) <= expectedSlides)) continue;
    const target = path.resolve(directory, entry.name);
    if (!isPathInside(directory, target)) throw new Error(`拒絕清理場景目錄外的檔案：${target}`);
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`拒絕清理非一般檔案或 reparse point：${target}`);
    await fs.unlink(target);
  }
}

async function twoPassLoudnorm(input, output, config, tools) {
  const targetI = config.video.integratedLufs;
  const targetTp = config.video.truePeakDb;
  const analysis = await runProcess(tools.ffmpeg, [
    '-hide_banner', '-nostats', '-i', input,
    '-vn', '-af', `loudnorm=I=${targetI}:TP=${targetTp}:LRA=11:print_format=json`,
    '-f', 'null', os.platform() === 'win32' ? 'NUL' : '/dev/null',
  ], { allowFailure: true, timeoutMs: 600000 });
  const match = analysis.stderr.match(/\{[\s\S]*?"target_offset"\s*:\s*"[^"]+"[\s\S]*?\}/gu)?.at(-1);
  if (!match) throw new Error(`無法解析 loudnorm 第一階段結果：${analysis.stderr.slice(-2000)}`);
  const measured = JSON.parse(match);
  const required = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'];
  if (required.some((key) => !Number.isFinite(Number(measured[key])))) {
    throw new Error(`loudnorm 測量值無效：${JSON.stringify(measured)}`);
  }
  const filter = [
    `loudnorm=I=${targetI}`, `TP=${targetTp}`, 'LRA=11',
    `measured_I=${measured.input_i}`, `measured_TP=${measured.input_tp}`,
    `measured_LRA=${measured.input_lra}`, `measured_thresh=${measured.input_thresh}`,
    `offset=${measured.target_offset}`, 'linear=true', 'print_format=summary',
  ].join(':');
  await runProcess(tools.ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error', '-i', input,
    '-c:v', 'copy', '-af', filter,
    '-c:a', config.video.audioCodec, '-b:a', config.video.audioBitrate,
    '-movflags', '+faststart', output,
  ], { timeoutMs: 1_800_000 });
  return measured;
}

function chunkCaption(text, maxChars = 36) {
  const clauses = String(text)
    .replaceAll(';', '；')
    .replaceAll(',', '，')
    .split(/(?<=[。！？；：])\s*|(?<=，)\s*/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const splitClauses = [];
  for (const original of clauses) {
    let remainder = original;
    while ([...remainder].length > maxChars) {
      const characters = [...remainder];
      let cut = maxChars;
      const window = characters.slice(0, maxChars + 1).join('');
      const boundary = Math.max(window.lastIndexOf(' '), window.lastIndexOf('，'), window.lastIndexOf('；'), window.lastIndexOf('：'));
      if (boundary >= Math.floor(maxChars * 0.6)) cut = [...window.slice(0, boundary + 1)].length;
      splitClauses.push(characters.slice(0, cut).join('').trim());
      remainder = characters.slice(cut).join('').trim();
    }
    if (remainder) splitClauses.push(remainder);
  }
  const chunks = [];
  for (const clause of splitClauses) {
    const length = [...clause].length;
    if (!chunks.length || [...chunks.at(-1)].length + length > maxChars) chunks.push(clause);
    else chunks[chunks.length - 1] += clause;
  }
  return chunks.length ? chunks : [String(text).trim()];
}

async function writeAccessibility(config, narrationDisplay, chapters) {
  const cues = [];
  let cueNumber = 1;
  for (const chapter of chapters) {
    const narration = narrationDisplay.find((item) => item.slide === chapter.slide);
    if (!narration) throw new Error(`缺少第 ${chapter.slide} 頁字幕文字。`);
    const chunks = chunkCaption(narration.caption);
    const start = chapter.startSeconds + config.video.preRollMs / 1000;
    const usable = Math.max(0.5, chapter.audioDurationSeconds);
    const weights = chunks.map((chunk) => Math.max(8, [...chunk].length));
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
    let cursor = start;
    chunks.forEach((chunk, index) => {
      const end = index === chunks.length - 1 ? start + usable : cursor + usable * weights[index] / totalWeight;
      cues.push({ number: cueNumber, start: cursor, end, text: chunk });
      cueNumber += 1;
      cursor = end;
    });
  }
  const srt = cues.map((cue) => `${cue.number}\n${secondsToClock(cue.start, true)} --> ${secondsToClock(cue.end, true)}\n${cue.text}`).join('\n\n');
  await writeTextAtomic(config.paths.subtitles, `${srt}\n`);
  const vtt = ['WEBVTT', '', ...cues.flatMap((cue) => [
    `${secondsToClock(cue.start)} --> ${secondsToClock(cue.end)}`,
    cue.text,
    '',
  ])].join('\n');
  await writeTextAtomic(config.paths.webvtt, vtt);
  const chapterText = chapters.map((chapter) => {
    const total = Math.floor(chapter.startSeconds);
    const h = String(Math.floor(total / 3600)).padStart(2, '0');
    const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const s = String(total % 60).padStart(2, '0');
    return `${h}:${m}:${s}  ${chapter.title}`;
  }).join('\n');
  await writeTextAtomic(config.paths.chapters, `${chapterText}\n`);
  return { cues: cues.length, srt: config.paths.subtitles, webvtt: config.paths.webvtt, chapters: config.paths.chapters };
}

export async function buildVideo(config, plan, audioManifest) {
  const tools = await mediaTools();
  await ensureDir(config.paths.segments);
  await ensureDir(config.paths.video);
  await cleanupStaleSegments(config, plan.slides.length);
  const chapters = [];
  let timeline = 0;
  const segmentFiles = [];
  let reusedSegments = 0;

  for (let index = 0; index < plan.slides.length; index += 1) {
    const slideNumber = index + 1;
    const image = path.join(config.paths.slides, `slide-${slideNumber}.png`);
    const audio = audioManifest.slides.find((item) => item.slide === slideNumber)?.output;
    if (!audio || !await pathExists(audio)) throw new Error(`缺少第 ${slideNumber} 頁音訊。`);
    if (!await pathExists(image)) throw new Error(`缺少第 ${slideNumber} 頁 PNG：${image}`);
    const audioProbe = await probeMedia(audio, tools.ffprobe);
    const audioDuration = durationFromProbe(audioProbe);
    const requestedDuration = audioDuration + (config.video.preRollMs + config.video.tailPaddingMs) / 1000;
    const targetDuration = Math.ceil(requestedDuration * config.video.fps) / config.video.fps;
    const segment = path.join(config.paths.segments, `slide-${String(slideNumber).padStart(3, '0')}.mp4`);
    const sidecar = `${segment}.json`;
    const fingerprint = sha256(JSON.stringify({
      imageSha256: await sha256File(image),
      audioSha256: await sha256File(audio),
      audioFingerprint: audioManifest.slides.find((item) => item.slide === slideNumber)?.fingerprint,
      targetDuration,
      video: config.video,
    }));
    let reused = false;
    if (await pathExists(segment) && await pathExists(sidecar)) {
      const previous = await readJson(sidecar).catch(() => null);
      if (previous?.fingerprint === fingerprint) {
        reused = await validateSegmentForReuse(segment, previous, config, tools).then(() => true).catch(() => false);
      }
    }
    if (!reused) {
      const partial = temporaryMediaPath(segment);
      try {
        await runProcess(tools.ffmpeg, [
          '-y', '-hide_banner', '-loglevel', 'error',
          '-loop', '1', '-framerate', String(config.video.fps), '-i', image,
          '-i', audio,
          '-filter_complex', `[0:v]scale=1920:1080:flags=lanczos,format=yuv420p[v];[1:a]adelay=${config.video.preRollMs}:all=1,apad[a]`,
          '-map', '[v]', '-map', '[a]',
          '-c:v', config.video.videoCodec, '-preset', 'fast', '-crf', String(config.video.crf), '-tune', 'stillimage',
          '-r', String(config.video.fps), '-fps_mode', 'cfr',
          '-c:a', config.video.audioCodec, '-b:a', config.video.audioBitrate,
          '-t', targetDuration.toFixed(3), '-movflags', '+faststart', partial,
        ], { timeoutMs: 600000 });
        await inspectSegmentOutput(partial, tools, config);
        await replaceFileAtomic(partial, segment);
      } finally {
        await fs.rm(partial, { force: true });
      }
      const output = await inspectSegmentOutput(segment, tools, config);
      await writeJsonAtomic(sidecar, { fingerprint, slide: slideNumber, image, audio, targetDuration, ...output });
    } else reusedSegments += 1;
    const segmentProbe = await probeMedia(segment, tools.ffprobe);
    const segmentDuration = durationFromProbe(segmentProbe);
    chapters.push({
      slide: slideNumber,
      slideId: plan.slides[index].id,
      title: plan.slides[index].title,
      startSeconds: Number(timeline.toFixed(3)),
      durationSeconds: Number(segmentDuration.toFixed(3)),
      audioDurationSeconds: Number(audioDuration.toFixed(3)),
      segment,
    });
    timeline += segmentDuration;
    segmentFiles.push(segment);
  }

  const concatPath = path.join(config.paths.segments, 'concat.txt');
  const concatEntries = segmentFiles.map((file) => path.basename(file));
  if (concatEntries.some((name) => !/^slide-\d{3}\.mp4$/u.test(name))) throw new Error('場景檔名不符合安全 concat 規格。');
  await writeTextAtomic(concatPath, `${concatEntries.map((name) => `file '${name}'`).join('\n')}\n`, 'utf8');
  const rawVideo = path.join(config.paths.video, `${config.projectId}-raw.mp4`);
  const rawPartial = temporaryMediaPath(rawVideo);
  try {
    await runProcess(tools.ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '1', '-i', concatPath,
      '-map', '0:v:0', '-map', '0:a:0',
      '-vf', `fps=${config.video.fps},format=yuv420p`,
      '-af', 'aresample=async=1:first_pts=0',
      '-c:v', config.video.videoCodec, '-preset', 'fast', '-crf', String(config.video.crf),
      '-r', String(config.video.fps), '-fps_mode', 'cfr',
      '-c:a', config.video.audioCodec, '-b:a', config.video.audioBitrate,
      '-movflags', '+faststart', rawPartial,
    ], { timeoutMs: 1_800_000 });
    await assertPlayableMedia(rawPartial, tools);
    await replaceFileAtomic(rawPartial, rawVideo);
  } finally {
    await fs.rm(rawPartial, { force: true });
  }
  let loudnorm = null;
  if (config.video.loudnessNormalization) {
    const finalPartial = temporaryMediaPath(config.paths.finalVideo);
    try {
      loudnorm = await twoPassLoudnorm(rawVideo, finalPartial, config, tools);
      await assertPlayableMedia(finalPartial, tools);
      await replaceFileAtomic(finalPartial, config.paths.finalVideo);
    } finally {
      await fs.rm(finalPartial, { force: true });
    }
  } else {
    await copyFileAtomic(rawVideo, config.paths.finalVideo);
  }
  const narrationDisplay = await readJson(config.paths.narrationDisplay);
  const accessibility = await writeAccessibility(config, narrationDisplay, chapters);
  const finalProbe = await probeMedia(config.paths.finalVideo, tools.ffprobe);
  const manifest = {
    schemaVersion: 1,
    output: config.paths.finalVideo,
    slides: plan.slides.length,
    durationSeconds: Number(durationFromProbe(finalProbe).toFixed(3)),
    reusedSegments,
    chapters,
    accessibility,
    loudnorm,
    probe: finalProbe,
    generatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(config.paths.videoManifest, manifest);
  return manifest;
}
