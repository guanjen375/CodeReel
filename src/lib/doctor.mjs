import fs from 'node:fs/promises';
import { checkPowerPoint } from './render.mjs';
import { assertLlmPrivacy, checkClaudeCli, llmSetupInstructions } from './llm.mjs';
import { findCommand, isLoopbackUrl, runProcess } from './utils.mjs';
import { azureEndpoint } from './tts.mjs';

async function commandVersion(name, args = ['-version']) {
  const command = await findCommand(name);
  if (!command) return { available: false, path: null, version: null };
  const result = await runProcess(command, args, { allowFailure: true });
  return { available: result.code === 0, path: command, version: (result.stdout || result.stderr).split(/\r?\n/u)[0].trim() };
}

async function llmStatus(config) {
  if (config.llm.provider === 'fixture') return { available: true, provider: 'fixture', local: true };
  if (config.llm.provider === 'claude-cli') return await checkClaudeCli(config);
  const local = isLoopbackUrl(config.llm.baseUrl);
  const url = config.llm.provider === 'ollama'
    ? `${config.llm.baseUrl.replace(/\/$/u, '').replace(/\/v1$/u, '')}/api/tags`
    : `${config.llm.baseUrl.replace(/\/$/u, '')}/models`;
  try {
    const headers = {};
    if (config.llm.apiKeyEnv && process.env[config.llm.apiKeyEnv]) headers.authorization = `Bearer ${process.env[config.llm.apiKeyEnv]}`;
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!response.ok) return { available: false, provider: config.llm.provider, local, endpoint: config.llm.baseUrl, status: response.status };
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > config.llm.maxResponseBytes) throw new Error('模型清單回應過大。');
    const payload = JSON.parse(text);
    const models = config.llm.provider === 'ollama'
      ? (payload.models || []).map((item) => item.name)
      : (payload.data || []).map((item) => item.id);
    const selected = config.llm.model === 'auto' ? models[0] : config.llm.model;
    const modelFound = Boolean(selected && models.includes(selected));
    return { available: modelFound, provider: config.llm.provider, local, endpoint: config.llm.baseUrl, status: response.status, selectedModel: selected || null, modelFound };
  } catch (error) {
    return {
      available: false,
      provider: config.llm.provider,
      local,
      endpoint: config.llm.baseUrl,
      error: `無法連線到本機 LLM 端點：${config.llm.baseUrl}`,
      cause: error.message,
      nextSteps: llmSetupInstructions(config),
    };
  }
}

async function ttsStatus(config) {
  if (config.tts.provider === 'fixture') return { available: true, provider: 'fixture', paid: false };
  if (config.tts.provider === 'none') return { available: true, provider: 'none', canBuildVideo: false };
  if (config.tts.provider === 'piper') {
    const companion = `${config.tts.piperModel}.json`;
    const [executable, modelStat, companionStat] = await Promise.all([
      findCommand(config.tts.piperExecutable || 'piper'),
      fs.stat(config.tts.piperModel || '').catch(() => null),
      fs.stat(companion).catch(() => null),
    ]);
    return {
      available: Boolean(executable && modelStat?.isFile() && companionStat?.isFile()), provider: 'piper', paid: false,
      executable, model: config.tts.piperModel || null, modelExists: Boolean(modelStat?.isFile()),
      companion, companionExists: Boolean(companionStat?.isFile()),
    };
  }
  const keyName = config.tts.azureKeyEnv || 'AZURE_SPEECH_KEY';
  const regionName = config.tts.azureRegionEnv || 'AZURE_SPEECH_REGION';
  const endpointName = config.tts.azureEndpointEnv || 'AZURE_SPEECH_ENDPOINT';
  let endpoint = null;
  let endpointError = null;
  try { endpoint = azureEndpoint(config); }
  catch (error) { endpointError = error.message; }
  return {
    available: Boolean(process.env[keyName] && endpoint),
    provider: 'azure', paid: true,
    keyConfigured: Boolean(process.env[keyName]),
    regionOrEndpointConfigured: Boolean(process.env[regionName] || process.env[endpointName]),
    endpoint,
    endpointError,
  };
}

async function ffmpegCapabilities(command) {
  if (!command?.available || !command.path) return { libx264: false, aac: false, loudnorm: false };
  const [encoders, filters] = await Promise.all([
    runProcess(command.path, ['-hide_banner', '-encoders'], { allowFailure: true, timeoutMs: 30000 }),
    runProcess(command.path, ['-hide_banner', '-filters'], { allowFailure: true, timeoutMs: 30000 }),
  ]);
  return {
    libx264: /\blibx264\b/u.test(encoders.stdout + encoders.stderr),
    aac: /^\s*A[\.A-Z]{5}\s+aac\s/gmu.test(encoders.stdout + encoders.stderr) || /\baac\b/u.test(encoders.stdout + encoders.stderr),
    loudnorm: /\bloudnorm\b/u.test(filters.stdout + filters.stderr),
  };
}

export async function runDoctor(config) {
  assertLlmPrivacy(config);
  const repoStat = await fs.stat(config.repoPath).catch(() => null);
  const [ffmpeg, ffprobe, powerPoint, llm, tts] = await Promise.all([
    commandVersion('ffmpeg'), commandVersion('ffprobe'), checkPowerPoint(), llmStatus(config),
    ttsStatus(config),
  ]);
  ffmpeg.capabilities = await ffmpegCapabilities(ffmpeg);
  if (ffmpeg.available && (!ffmpeg.capabilities.libx264 || !ffmpeg.capabilities.aac || (config.video.loudnessNormalization && !ffmpeg.capabilities.loudnorm))) {
    ffmpeg.available = false;
  }
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const report = {
    node: { available: nodeMajor >= 20, version: process.versions.node },
    repo: { available: Boolean(repoStat?.isDirectory()), path: config.repoPath },
    ffmpeg,
    ffprobe,
    powerPoint,
    llm,
    tts,
    privacy: {
      requireLocalLlm: config.privacy.requireLocalLlm,
      llmEndpointIsLocal: llm.local !== false,
      sourceCodeLeavesMachine: llm.local === false,
    },
  };
  report.canBuildDeck = report.node.available && report.repo.available && powerPoint.available && llm.available;
  report.canBuildVideo = report.canBuildDeck && ffmpeg.available && ffprobe.available && tts.available && config.tts.provider !== 'none';
  return report;
}
