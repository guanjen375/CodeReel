import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanupStaleNarrationArtifacts, synthesizeNarration } from '../src/lib/tts.mjs';
import { buildVideo, cleanupStaleSegments } from '../src/lib/media.mjs';
import { reuseRenderedDeck } from '../src/lib/pipeline.mjs';
import { validateSequentialSlideIds, validateSlideFileSet } from '../src/lib/qa.mjs';
import { findCommand, runProcess } from '../src/lib/utils.mjs';

async function makeArtifactTree() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codereel-artifacts-'));
  const paths = {
    audio: path.join(root, 'audio'),
    ssml: path.join(root, 'audio', 'ssml'),
    video: path.join(root, 'video'),
    segments: path.join(root, 'video', 'segments'),
    slides: path.join(root, 'deck', 'slides'),
    renderReport: path.join(root, 'qa', 'render.json'),
    overflowReport: path.join(root, 'qa', 'overflow.json'),
  };
  await Promise.all(Object.values(paths).filter((value) => !path.extname(value)).map((directory) => fs.mkdir(directory, { recursive: true })));
  await fs.mkdir(path.dirname(paths.renderReport), { recursive: true });
  return { root, paths };
}

test('頁數縮減只清理 runRoot 內超出範圍的音訊、SSML 與場景 sidecar', async (t) => {
  const { root, paths } = await makeArtifactTree();
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const files = [
    path.join(paths.audio, 'slide-002.wav'),
    path.join(paths.audio, 'slide-003.wav'),
    path.join(paths.audio, 'slide-003.wav.json'),
    path.join(paths.audio, 'slide-003.json'),
    path.join(paths.ssml, 'slide-003.ssml'),
    path.join(paths.ssml, 'slide-003.ssml.json'),
    path.join(paths.segments, 'slide-002.mp4'),
    path.join(paths.segments, 'slide-003.mp4'),
    path.join(paths.segments, 'slide-003.mp4.json'),
  ];
  await Promise.all(files.map((file) => fs.writeFile(file, 'artifact')));
  const config = { runRoot: root, paths, tts: { provider: 'fixture' } };
  await cleanupStaleNarrationArtifacts(config, 2);
  await cleanupStaleSegments(config, 2);
  assert.equal(await fs.stat(path.join(paths.audio, 'slide-002.wav')).then(() => true), true);
  assert.equal(await fs.stat(path.join(paths.segments, 'slide-002.mp4')).then(() => true), true);
  for (const file of files.filter((name) => name.includes('003'))) {
    assert.equal(await fs.stat(file).then(() => true, () => false), false, `${file} should be removed`);
  }
});

test('TTS 成功後的清理會移除同頁舊 provider 副檔名', async (t) => {
  const { root, paths } = await makeArtifactTree();
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const wav = path.join(paths.audio, 'slide-001.wav');
  const wavSidecar = `${wav}.json`;
  const mp3 = path.join(paths.audio, 'slide-001.mp3');
  const mp3Sidecar = `${mp3}.json`;
  await Promise.all([wav, wavSidecar, mp3, mp3Sidecar].map((file) => fs.writeFile(file, 'artifact')));
  await cleanupStaleNarrationArtifacts({ runRoot: root, paths, tts: { provider: 'azure' } }, 1);
  assert.equal(await fs.stat(mp3).then(() => true, () => false), true);
  assert.equal(await fs.stat(mp3Sidecar).then(() => true, () => false), true);
  assert.equal(await fs.stat(wav).then(() => true, () => false), false);
  assert.equal(await fs.stat(wavSidecar).then(() => true, () => false), false);
});

test('Piper prerequisite 失敗時不會先刪除既有音訊', async (t) => {
  const { root, paths } = await makeArtifactTree();
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const existing = path.join(paths.audio, 'slide-001.mp3');
  await fs.writeFile(existing, 'existing-output');
  const config = {
    runRoot: root,
    cacheRoot: path.join(root, 'cache'),
    paths: { ...paths, intermediate: path.join(root, 'intermediate'), egressReport: path.join(root, 'intermediate', 'egress.json') },
    llm: { timeoutMs: 1000 },
    tts: { provider: 'piper', voice: 'fixture', rate: '0%', piperModel: '', pronunciation: {} },
  };
  await assert.rejects(
    () => synthesizeNarration(config, [{ slide: 1, title: '一', spoken: '測試', spokenCharacters: 2 }]),
    /Piper 需要/u,
  );
  assert.equal(await fs.stat(existing).then(() => true, () => false), true);
});

test('產物清理拒絕 runRoot 外的目錄', async (t) => {
  const { root, paths } = await makeArtifactTree();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codereel-outside-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  await assert.rejects(
    () => cleanupStaleSegments({ runRoot: root, paths: { ...paths, segments: outside } }, 1),
    /runRoot 外/u,
  );
  await assert.rejects(
    () => cleanupStaleNarrationArtifacts({ runRoot: root, paths: { ...paths, audio: outside }, tts: { provider: 'fixture' } }, 1),
    /runRoot 外/u,
  );
});

test('渲染快取逐頁解碼、驗證 1920×1080 並拒絕多頁', async (t) => {
  const ffmpeg = await findCommand('ffmpeg');
  if (!ffmpeg || !await findCommand('ffprobe')) return t.skip('ffmpeg/ffprobe unavailable');
  const { root, paths } = await makeArtifactTree();
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(paths.renderReport, JSON.stringify({ slides: 1, width: 1920, height: 1080 }));
  await fs.writeFile(paths.overflowReport, JSON.stringify({ passed: true, issueCount: 0 }));
  const slide1 = path.join(paths.slides, 'slide-1.png');
  await runProcess(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=1920x1080', '-frames:v', '1', slide1]);
  await reuseRenderedDeck({ paths }, 1);

  await fs.copyFile(slide1, path.join(paths.slides, 'slide-2.png'));
  await assert.rejects(() => reuseRenderedDeck({ paths }, 1), /頁面集合不符/u);
  await fs.rm(path.join(paths.slides, 'slide-2.png'));

  await runProcess(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=1280x720', '-frames:v', '1', slide1]);
  await assert.rejects(() => reuseRenderedDeck({ paths }, 1), /1280×720/u);
});

test('QA 不會讓同數量但缺頁、跨頁或別名檔案通過', () => {
  assert.match(validateSequentialSlideIds('manifest', [{ slide: 1 }, { slide: 3 }], 2), /1–2/u);
  assert.equal(validateSequentialSlideIds('manifest', [{ slide: 2 }, { slide: 1 }], 2), null);
  assert.match(
    validateSlideFileSet('PNG', ['slide-1.png', 'slide-3.png'], 2, /^slide-(\d+)\.png$/u, (id) => `slide-${id}.png`),
    /1–2/u,
  );
  assert.match(
    validateSlideFileSet('PNG', ['slide-1.png', 'slide-01.png'], 2, /^slide-(\d+)\.png$/u, (id) => `slide-${id}.png`),
    /1–2/u,
  );
});

test('segment 被替換成另一個可播放 MP4 時不會沿用舊 sidecar', async (t) => {
  const ffmpeg = await findCommand('ffmpeg');
  if (!ffmpeg || !await findCommand('ffprobe')) return t.skip('ffmpeg/ffprobe unavailable');
  const { root, paths } = await makeArtifactTree();
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const finalVideo = path.join(paths.video, 'final.mp4');
  const config = {
    runRoot: root,
    projectId: 'test',
    paths: {
      ...paths,
      finalVideo,
      videoManifest: path.join(paths.video, 'video-manifest.json'),
      subtitles: path.join(paths.video, 'subtitles.srt'),
      webvtt: path.join(paths.video, 'subtitles.vtt'),
      chapters: path.join(paths.video, 'chapters.txt'),
      narrationDisplay: path.join(root, 'narration-display.json'),
    },
    video: {
      fps: 30, preRollMs: 0, tailPaddingMs: 0,
      videoCodec: 'libx264', audioCodec: 'aac', audioBitrate: '96k', crf: 28,
      loudnessNormalization: false,
    },
  };
  const plan = { slides: [
    { id: 'slide-a', title: '第一頁' },
    { id: 'slide-b', title: '第二頁' },
  ] };
  await fs.writeFile(config.paths.narrationDisplay, JSON.stringify([
    { slide: 1, caption: '第一頁字幕。' },
    { slide: 2, caption: '第二頁字幕。' },
  ]));
  const audioSlides = [];
  for (let slide = 1; slide <= 2; slide += 1) {
    const image = path.join(paths.slides, `slide-${slide}.png`);
    const audio = path.join(paths.audio, `slide-${String(slide).padStart(3, '0')}.wav`);
    await runProcess(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${slide === 1 ? 'red' : 'blue'}:s=1920x1080`, '-frames:v', '1', image]);
    await runProcess(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${400 + slide * 100}:sample_rate=24000`, '-t', '1', '-c:a', 'pcm_s16le', audio]);
    audioSlides.push({ slide, output: audio, fingerprint: `audio-${slide}` });
  }
  const initial = await buildVideo(config, plan, { slides: audioSlides });
  assert.equal(initial.reusedSegments, 0);

  const replaced = path.join(paths.segments, 'slide-002.replacement.mp4');
  await runProcess(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=green:s=1920x1080:r=30',
    '-f', 'lavfi', '-i', 'sine=frequency=900:sample_rate=24000',
    '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', replaced,
  ], { timeoutMs: 120000 });
  await fs.copyFile(replaced, path.join(paths.segments, 'slide-002.mp4'));
  await fs.rm(replaced);

  const rerun = await buildVideo(config, plan, { slides: audioSlides });
  assert.equal(rerun.reusedSegments, 1);
});
