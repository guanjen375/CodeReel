import fs from 'node:fs/promises';
import path from 'node:path';
import { copyFileAtomic, ensureDir, findCommand, isPathInside, pathExists, readJson, replaceFileAtomic, runProcess, sha256, sha256File, stableStringify, writeJsonAtomic } from './utils.mjs';
import { escapeSsml, writeSsmlFile } from './narration.mjs';

export function azureEndpoint(config) {
  const endpointName = config.tts.azureEndpointEnv || 'AZURE_SPEECH_ENDPOINT';
  const regionName = config.tts.azureRegionEnv || 'AZURE_SPEECH_REGION';
  const configured = String(process.env[endpointName] || '').trim();
  const region = String(process.env[regionName] || '').trim().toLowerCase();
  let url;
  if (configured) {
    try { url = new URL(configured); }
    catch { throw new Error(`${endpointName} 不是有效 URL。`); }
  } else {
    if (!/^[a-z0-9-]{2,40}$/u.test(region)) throw new Error(`Azure TTS 需要有效的 ${endpointName} 或 ${regionName}。`);
    url = new URL(`https://${region}.tts.speech.microsoft.com/tts/cognitiveservices/v1`);
  }
  const host = url.hostname.toLowerCase();
  const allowedHost = /^(?:[a-z0-9-]+\.)?(?:tts\.speech\.microsoft\.com|cognitiveservices\.azure\.com|api\.cognitive\.microsoft\.com)$/u.test(host);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443') || !allowedHost) {
    throw new Error('Azure Speech endpoint 必須是核准的 Microsoft HTTPS host，且不可含帳密、query、fragment 或非 443 port。');
  }
  const normalizedPath = url.pathname.replace(/\/$/u, '');
  if (!normalizedPath) url.pathname = '/tts/cognitiveservices/v1';
  else if (normalizedPath !== '/tts/cognitiveservices/v1') throw new Error('Azure Speech endpoint path 必須是 /tts/cognitiveservices/v1。');
  url.pathname = '/tts/cognitiveservices/v1';
  return url.href;
}

function outputExtension(provider) {
  return provider === 'azure' ? '.mp3' : '.wav';
}

function audioName(slide, extension) {
  return `slide-${String(slide).padStart(3, '0')}${extension}`;
}

async function assertManagedDirectory(runRoot, directory) {
  const root = path.resolve(runRoot);
  const target = path.resolve(directory);
  if (!isPathInside(root, target)) throw new Error(`拒絕清理 runRoot 外的產物目錄：${target}`);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`runRoot 必須是實體資料夾：${root}`);
  let cursor = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = await fs.lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`產物目錄不可包含 reparse point：${cursor}`);
  }
  const [rootReal, targetReal] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
  if (!isPathInside(rootReal, targetReal)) throw new Error(`產物目錄實際路徑逃離 runRoot：${target}`);
}

async function removeStaleManagedFiles(runRoot, directory, pattern, shouldRemove) {
  await assertManagedDirectory(runRoot, directory);
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const match = entry.name.match(pattern);
    if (!match || !shouldRemove(match)) continue;
    const target = path.resolve(directory, entry.name);
    if (!isPathInside(directory, target)) throw new Error(`拒絕清理產物目錄外的檔案：${target}`);
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`拒絕清理非一般檔案或 reparse point：${target}`);
    await fs.unlink(target);
  }
}

export async function cleanupStaleNarrationArtifacts(config, expectedSlides) {
  const runRoot = config.runRoot || path.dirname(config.paths.audio);
  const expectedExtension = outputExtension(config.tts.provider).slice(1);
  await removeStaleManagedFiles(
    runRoot,
    config.paths.audio,
    /^slide-(\d+)\.(mp3|wav)(?:\.json)?$/u,
    (match) => Number(match[1]) < 1 || Number(match[1]) > expectedSlides || match[2] !== expectedExtension,
  );
  await removeStaleManagedFiles(
    runRoot,
    config.paths.audio,
    /^slide-(\d+)\.json$/u,
    (match) => Number(match[1]) < 1 || Number(match[1]) > expectedSlides,
  );
  await removeStaleManagedFiles(
    runRoot,
    config.paths.ssml,
    /^slide-(\d+)\.ssml(?:\.json)?$/u,
    (match) => Number(match[1]) < 1 || Number(match[1]) > expectedSlides || config.tts.provider !== 'azure',
  );
}

async function synthesizeAzure(entry, target, ssmlPath, config) {
  const keyName = config.tts.azureKeyEnv || 'AZURE_SPEECH_KEY';
  const key = process.env[keyName];
  if (!key) throw new Error(`Azure TTS 需要環境變數 ${keyName}。`);
  const ssml = await writeSsmlFile(ssmlPath, entry.spoken, config);
  const response = await fetch(azureEndpoint(config), {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'application/ssml+xml; charset=utf-8',
      'X-Microsoft-OutputFormat': config.tts.outputFormat,
      'User-Agent': 'CodeReel',
    },
    body: Buffer.from(ssml, 'utf8'),
    signal: AbortSignal.timeout(config.llm.timeoutMs || 180000),
    redirect: 'error',
  });
  if (!response.ok) {
    const requestId = response.headers.get('x-requestid') || response.headers.get('x-ms-request-id');
    throw new Error(`Azure TTS 第 ${entry.slide} 頁失敗：HTTP ${response.status}${requestId ? `，request-id ${requestId}` : ''}`);
  }
  const maximum = config.tts.maxAudioBytesPerSlide;
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum) throw new Error(`Azure TTS 第 ${entry.slide} 頁音訊超過 ${maximum} bytes。`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`Azure TTS 第 ${entry.slide} 頁沒有音訊內容。`);
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      throw new Error(`Azure TTS 第 ${entry.slide} 頁音訊超過 ${maximum} bytes。`);
    }
    chunks.push(value);
  }
  const partial = `${target}.${process.pid}.partial`;
  try {
    await fs.writeFile(partial, Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total));
    await replaceFileAtomic(partial, target);
  } finally {
    await fs.rm(partial, { force: true });
  }
}

async function synthesizePiper(entry, target, config) {
  if (!config.tts.piperModel) throw new Error('Piper provider 需要 tts.piperModel。');
  const executable = await findCommand(config.tts.piperExecutable || 'piper');
  if (!executable) throw new Error(`找不到 Piper：${config.tts.piperExecutable || 'piper'}`);
  const partial = `${target}.${process.pid}.partial.wav`;
  try {
    await runProcess(executable, ['--model', config.tts.piperModel, '--output_file', partial], { input: entry.spoken, timeoutMs: config.llm.timeoutMs || 180000 });
    await replaceFileAtomic(partial, target);
  } finally {
    await fs.rm(partial, { force: true });
  }
}

async function synthesizeFixture(entry, target) {
  const ffmpeg = await findCommand('ffmpeg');
  if (!ffmpeg) throw new Error('fixture TTS 需要 ffmpeg。');
  const duration = Math.min(4.5, Math.max(1.2, 1 + [...entry.spoken].length * 0.015));
  const partial = `${target}.${process.pid}.partial.wav`;
  try {
    await runProcess(ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono',
      '-t', duration.toFixed(3), '-c:a', 'pcm_s16le', partial,
    ], { timeoutMs: 60000 });
    await replaceFileAtomic(partial, target);
  } finally {
    await fs.rm(partial, { force: true });
  }
}

export async function validateAudio(file, slide, expectedSha256 = null) {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat || stat.size < 1024) throw new Error(`第 ${slide} 頁音訊不存在或異常過小：${file}`);
  const digest = await sha256File(file);
  if (expectedSha256 && digest !== expectedSha256) throw new Error(`第 ${slide} 頁音訊 hash 不符：${file}`);
  const ffprobe = await findCommand('ffprobe');
  if (!ffprobe) throw new Error('驗證音訊需要 ffprobe。');
  const probe = await runProcess(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { timeoutMs: 30000 });
  const parsed = JSON.parse(probe.stdout);
  const stream = parsed.streams?.find((item) => item.codec_type === 'audio');
  const durationSeconds = Number(parsed.format?.duration);
  if (!stream || !(durationSeconds > 0)) throw new Error(`第 ${slide} 頁音訊無法解碼：${file}`);
  return { bytes: stat.size, sha256: digest, durationSeconds, codec: stream.codec_name };
}

export async function prepareTtsEgress(config, narrations) {
  const provider = config.tts.provider;
  const items = narrations.map((entry) => ({
    slide: entry.slide,
    title: entry.title,
    text: entry.spoken,
    billableCharacters: [...entry.spoken].length,
  }));
  const billableCharacters = items.reduce((sum, item) => sum + item.billableCharacters, 0);
  const rate = Number(config.tts.ratePerMillionCharacters);
  const endpoint = provider === 'azure' ? azureEndpoint(config) : null;
  const approvalPayload = {
    schemaVersion: 1,
    provider,
    endpoint,
    voice: config.tts.voice,
    rate: config.tts.rate,
    outputFormat: config.tts.outputFormat,
    items,
  };
  const approvalDigest = sha256(stableStringify(approvalPayload));
  const report = {
    schemaVersion: 1,
    provider,
    externalTransfer: provider === 'azure',
    exactDataLeavingMachine: provider === 'azure' ? '只有下列核准後的旁白文字與 SSML 設定' : '無',
    voice: config.tts.voice,
    rate: config.tts.rate,
    endpoint,
    outputFormat: config.tts.outputFormat,
    billableCharacters,
    pricingSnapshot: Number.isFinite(rate) && rate > 0 ? {
      ratePerMillionCharacters: rate,
      currency: config.tts.pricingCurrency || null,
      region: process.env[config.tts.azureRegionEnv || 'AZURE_SPEECH_REGION'] || null,
      snapshotDate: config.tts.pricingSnapshotDate || null,
      estimatedCost: Number((billableCharacters / 1_000_000 * rate).toFixed(6)),
    } : null,
    items,
    approvalDigest,
    approvalFlag: `--approve-tts=${approvalDigest}`,
    generatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(config.paths.egressReport, report);
  return report;
}

export async function synthesizeNarration(config, narrations, { approvedEgressDigest = '' } = {}) {
  if (config.tts.provider === 'none') throw new Error('tts.provider=none：可以產生投影片，但無法產生有聲影片。');
  const slideIds = narrations.map((entry) => entry.slide);
  if (slideIds.some((slide, index) => slide !== index + 1)) throw new Error('旁白 slide 編號必須是由 1 開始、連續且唯一。');
  await ensureDir(config.paths.audio);
  await ensureDir(config.paths.ssml);
  const cacheDirectory = path.join(config.cacheRoot, 'audio');
  await ensureDir(cacheDirectory);
  const extension = outputExtension(config.tts.provider);
  const pending = [];
  const results = [];
  const piperModelFingerprint = config.tts.provider === 'piper' && config.tts.piperModel && await pathExists(config.tts.piperModel)
    ? await sha256File(config.tts.piperModel)
    : null;
  const piperConfigPath = config.tts.provider === 'piper' ? `${config.tts.piperModel}.json` : null;
  const piperConfigFingerprint = piperConfigPath && await pathExists(piperConfigPath) ? await sha256File(piperConfigPath) : null;
  const piperExecutablePath = config.tts.provider === 'piper' ? await findCommand(config.tts.piperExecutable || 'piper') : null;
  const piperExecutableFingerprint = piperExecutablePath ? await sha256File(piperExecutablePath) : null;
  if (config.tts.provider === 'piper' && (!piperModelFingerprint || !piperConfigFingerprint || !piperExecutableFingerprint)) {
    throw new Error('Piper 需要可用的 executable、.onnx model 與同名 .onnx.json 設定檔。');
  }

  for (const entry of narrations) {
    const fingerprint = sha256(JSON.stringify({
      provider: config.tts.provider,
      endpoint: config.tts.provider === 'azure' ? azureEndpoint(config) : null,
      voice: config.tts.voice,
      rate: config.tts.rate,
      outputFormat: config.tts.outputFormat,
      spoken: entry.spoken,
      piperModel: config.tts.piperModel || null,
      piperModelFingerprint,
      piperConfigFingerprint,
      piperExecutableFingerprint,
    }));
    const cacheFile = path.join(cacheDirectory, `${fingerprint}${extension}`);
    const outputFile = path.join(config.paths.audio, audioName(entry.slide, extension));
    if (await pathExists(cacheFile)) {
      const cached = await validateAudio(cacheFile, entry.slide).catch(() => null);
      if (cached) {
        await copyFileAtomic(cacheFile, outputFile);
        results.push({ slide: entry.slide, output: outputFile, cacheHit: true, fingerprint, characters: entry.spokenCharacters, ...cached });
      } else pending.push({ entry, fingerprint, cacheFile, outputFile });
    } else {
      pending.push({ entry, fingerprint, cacheFile, outputFile });
    }
  }

  const egress = await prepareTtsEgress(config, pending.map((item) => item.entry));
  if (config.tts.provider === 'azure' && egress.billableCharacters > config.tts.maxBillableCharacters) {
    const error = new Error(`正式語音共有 ${egress.billableCharacters} 字，超過 tts.maxBillableCharacters=${config.tts.maxBillableCharacters}。`);
    error.code = 'TTS_LIMIT_EXCEEDED';
    throw error;
  }
  if (config.tts.provider === 'azure' && egress.pricingSnapshot?.estimatedCost > config.tts.maxEstimatedCost) {
    const error = new Error(`正式語音預估費用 ${egress.pricingSnapshot.estimatedCost} 超過 tts.maxEstimatedCost=${config.tts.maxEstimatedCost}。`);
    error.code = 'TTS_LIMIT_EXCEEDED';
    throw error;
  }
  if (config.tts.provider === 'azure' && pending.length > 0 && approvedEgressDigest !== egress.approvalDigest) {
    const error = new Error(
      `正式語音有 ${pending.length} 頁未命中快取，共 ${egress.billableCharacters} 字。` +
      `\n已產生外送預覽：${config.paths.egressReport}` +
      `\n確認文字與付費方案後，以 ${egress.approvalFlag} 重新執行；已完成的投影片不會重做。`,
    );
    error.code = 'PAID_APPROVAL_REQUIRED';
    throw error;
  }

  for (const item of pending) {
    const ssmlPath = path.join(config.paths.ssml, `slide-${String(item.entry.slide).padStart(3, '0')}.ssml`);
    if (config.tts.provider === 'azure') await synthesizeAzure(item.entry, item.cacheFile, ssmlPath, config);
    else if (config.tts.provider === 'piper') await synthesizePiper(item.entry, item.cacheFile, config);
    else await synthesizeFixture(item.entry, item.cacheFile);
    const validated = await validateAudio(item.cacheFile, item.entry.slide);
    await copyFileAtomic(item.cacheFile, item.outputFile);
    results.push({
      slide: item.entry.slide,
      output: item.outputFile,
      cacheHit: false,
      fingerprint: item.fingerprint,
      characters: item.entry.spokenCharacters,
      ...validated,
    });
  }
  results.sort((a, b) => a.slide - b.slide);
  for (const result of results) Object.assign(result, await validateAudio(result.output, result.slide, result.sha256));
  await cleanupStaleNarrationArtifacts(config, narrations.length);
  const manifest = {
    schemaVersion: 1,
    provider: config.tts.provider,
    voice: config.tts.voice,
    rate: config.tts.rate,
    slides: results,
    cacheHits: results.filter((item) => item.cacheHit).length,
    synthesized: results.filter((item) => !item.cacheHit).length,
    generatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(path.join(config.paths.audio, 'audio-manifest.json'), manifest);
  return manifest;
}

export async function loadNarrationTts(config) {
  return await readJson(config.paths.narrationTts);
}
