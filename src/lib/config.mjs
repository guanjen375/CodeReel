import fs from 'node:fs/promises';
import path from 'node:path';
import { isPathInside, pathExists, readJson, safeName, sha256, writeJsonAtomic } from './utils.mjs';

const activeConfigRelativePath = path.join('.codereel', 'active-config.json');

const defaults = {
  outputRoot: './output',
  project: {
    title: '',
    targetMinutes: 8,
    minSlides: 10,
    maxSlides: 24,
    fundamentalsRatio: 0.7,
    purpose: '快速完成專案的安裝、啟動、驗證與第一個實際操作',
  },
  llm: {
    provider: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'auto',
    apiKeyEnv: '',
    temperature: 0.2,
    timeoutMs: 600000,
    contextWindow: 32768,
    maxResponseBytes: 4194304,
    maxSourceChars: 32000,
    maxSelectedFiles: 28,
  },
  slides: {
    themeFile: './templates/titanium-dark.json',
    fontFace: 'Microsoft JhengHei',
    codeFontFace: 'Cascadia Mono',
    renderProvider: 'powerpoint',
    width: 1920,
    height: 1080,
  },
  tts: {
    provider: 'azure',
    voice: 'zh-TW-HsiaoChenNeural',
    rate: '-6%',
    outputFormat: 'audio-24khz-96kbitrate-mono-mp3',
    maxBillableCharacters: 30000,
    maxEstimatedCost: 10,
    maxAudioBytesPerSlide: 26214400,
    estimatedCharactersPerMinute: 260,
    azureKeyEnv: 'AZURE_SPEECH_KEY',
    azureRegionEnv: 'AZURE_SPEECH_REGION',
    azureEndpointEnv: 'AZURE_SPEECH_ENDPOINT',
    ratePerMillionCharacters: null,
    pricingCurrency: null,
    pricingSnapshotDate: null,
    licenseRecord: '',
    piperExecutable: 'piper',
    piperModel: '',
    pronunciation: {
      spellAcronyms: true,
      underscoresAsPause: true,
      replacements: [
        { from: 'aicode', to: 'A I code' },
        { from: 'CodeReel', to: 'Code Reel' },
        { from: 'README', to: 'read me' },
        { from: 'RAG', to: 'R A G' },
        { from: 'LLM', to: 'L L M' },
        { from: 'API', to: 'A P I' },
        { from: 'CLI', to: 'C L I' },
      ],
    },
  },
  video: {
    fps: 30,
    preRollMs: 600,
    tailPaddingMs: 1500,
    videoCodec: 'libx264',
    audioCodec: 'aac',
    audioBitrate: '160k',
    crf: 21,
    loudnessNormalization: true,
    integratedLufs: -16,
    truePeakDb: -1.5,
    burnSubtitles: false,
  },
  scan: {
    maxFileBytes: 524288,
    maxFiles: 4000,
    includeExtensions: [
      '.md', '.txt', '.rst', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
      '.py', '.go', '.rs', '.java', '.kt', '.kts', '.c', '.h', '.cpp', '.hpp',
      '.cs', '.php', '.rb', '.swift', '.scala', '.sh', '.ps1', '.bat', '.cmd',
      '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.xml',
      '.html', '.css', '.scss', '.sql', '.proto', '.dockerfile',
    ],
    excludeDirectories: [
      '.git', '.svn', '.hg', 'node_modules', 'vendor', 'dist', 'build', 'coverage',
      '.next', '.nuxt', '.cache', '.codereel', '.venv', 'venv', '__pycache__',
      'target', 'bin', 'obj', 'output', 'demo-output',
    ],
    excludeFiles: [
      '.env', '.env.local', '.env.production', 'id_rsa', 'id_ed25519',
      'credentials.json', 'service-account.json',
    ],
  },
  privacy: { requireLocalLlm: true, sendOnlyNarrationToTts: true },
};

function mergeDeep(base, override) {
  if (Array.isArray(override)) return [...override];
  if (!override || typeof override !== 'object') return override ?? base;
  const result = { ...(base && typeof base === 'object' ? base : {}) };
  for (const [key, value] of Object.entries(override)) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? mergeDeep(result[key], value)
      : value;
  }
  return result;
}

function resolveOptional(configDir, value) {
  if (!value) return value;
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(configDir, value);
}

export async function loadConfig(configPath) {
  const absoluteConfigPath = path.resolve(configPath);
  const configDir = path.dirname(absoluteConfigPath);
  if (!await pathExists(absoluteConfigPath)) {
    throw new Error(`找不到設定檔：${absoluteConfigPath}\n請先執行 codereel init --repo <來源 repo 路徑>。`);
  }
  const raw = mergeDeep(defaults, await readJson(absoluteConfigPath));
  if (!raw.repoPath) throw new Error('設定缺少 repoPath。');
  raw.configPath = absoluteConfigPath;
  raw.configDir = configDir;
  raw.repoPath = resolveOptional(configDir, raw.repoPath);
  raw.outputRoot = resolveOptional(configDir, raw.outputRoot || './output');
  raw.slides.themeFile = resolveOptional(configDir, raw.slides.themeFile);
  raw.llm.fixturePlan = resolveOptional(configDir, raw.llm.fixturePlan);
  raw.tts.piperModel = resolveOptional(configDir, raw.tts.piperModel);
  const repoName = path.basename(raw.repoPath);
  raw.projectId = safeName(raw.project.id || repoName, 'repository');
  raw.runId = `${raw.projectId}-${sha256(path.resolve(raw.repoPath).toLowerCase()).slice(0, 8)}`;
  raw.runRoot = path.join(raw.outputRoot, raw.runId);
  raw.paths = createPaths(raw.runRoot, raw.projectId);
  raw.cacheRoot = path.join(raw.outputRoot, '.codereel-cache', raw.runId);
  validateConfig(raw);
  return raw;
}

export async function setActiveConfig(configPath, workingDirectory = process.cwd()) {
  const absoluteConfigPath = path.resolve(workingDirectory, String(configPath));
  const configStat = await fs.lstat(absoluteConfigPath).catch(() => null);
  if (!configStat?.isFile() || configStat.isSymbolicLink()) throw new Error(`無法啟用非一般設定檔：${absoluteConfigPath}`);
  const activeConfigPath = path.resolve(workingDirectory, activeConfigRelativePath);
  await writeJsonAtomic(activeConfigPath, {
    schemaVersion: 1,
    configPath: absoluteConfigPath,
  });
  return activeConfigPath;
}

export async function resolveConfigPath(configArgument, workingDirectory = process.cwd()) {
  if (configArgument === true) throw new Error('--config 必須提供設定檔路徑。');
  if (configArgument) return path.resolve(workingDirectory, String(configArgument));

  const activeConfigPath = path.resolve(workingDirectory, activeConfigRelativePath);
  if (!await pathExists(activeConfigPath)) {
    throw new Error(`尚未選定目前專案。\n請先執行 codereel init --repo <來源 repo 路徑>，或加入 --config <設定檔>。`);
  }

  let active;
  try {
    active = await readJson(activeConfigPath);
  } catch {
    throw new Error(`目前設定紀錄無法讀取：${activeConfigPath}\n請重新執行 codereel init --repo <來源 repo 路徑>。`);
  }
  if (active?.schemaVersion !== 1 || typeof active.configPath !== 'string' || !path.isAbsolute(active.configPath)) {
    throw new Error(`目前設定紀錄格式錯誤：${activeConfigPath}\n請重新執行 codereel init --repo <來源 repo 路徑>。`);
  }
  const resolved = path.normalize(active.configPath);
  const configStat = await fs.lstat(resolved).catch(() => null);
  if (!configStat?.isFile() || configStat.isSymbolicLink()) {
    throw new Error(`目前設定檔已不存在：${resolved}\n請重新執行 codereel init --repo <來源 repo 路徑>。`);
  }
  return resolved;
}

function validateConfig(config) {
  if (!config.repoPath) throw new Error('設定缺少 repoPath。');
  if (!config.outputRoot) throw new Error('設定缺少 outputRoot。');
  if (path.resolve(config.repoPath) === path.resolve(config.outputRoot)) {
    throw new Error('outputRoot 不可等於 repoPath；請使用獨立輸出資料夾。');
  }
  if (isPathInside(config.repoPath, config.runRoot) || isPathInside(config.runRoot, config.repoPath)) {
    throw new Error('來源 repo 與實際輸出資料夾不可互相包含；請把 outputRoot 設在來源 repo 外。');
  }
  if (isPathInside(config.repoPath, config.cacheRoot) || isPathInside(config.cacheRoot, config.repoPath)) {
    throw new Error('來源 repo 與快取資料夾不可互相包含；請把 outputRoot 設在來源 repo 外。');
  }
  if (!['openai-compatible', 'ollama', 'fixture'].includes(config.llm.provider)) {
    throw new Error(`不支援的 llm.provider：${config.llm.provider}`);
  }
  if (!Number.isInteger(config.llm.maxResponseBytes) || config.llm.maxResponseBytes < 65536 || config.llm.maxResponseBytes > 16 * 1024 * 1024) {
    throw new Error('llm.maxResponseBytes 必須介於 65536 與 16777216。');
  }
  if (!Number.isInteger(config.llm.timeoutMs) || config.llm.timeoutMs < 1000 || config.llm.timeoutMs > 3_600_000) {
    throw new Error('llm.timeoutMs 必須介於 1000 與 3600000 毫秒。');
  }
  if (config.llm.provider === 'ollama' && (!Number.isInteger(config.llm.contextWindow) || config.llm.contextWindow < 16384 || config.llm.contextWindow > 262144)) {
    throw new Error('使用 Ollama 時，llm.contextWindow 必須介於 16384 與 262144。');
  }
  if (!['azure', 'piper', 'fixture', 'none'].includes(config.tts.provider)) {
    throw new Error(`不支援的 tts.provider：${config.tts.provider}`);
  }
  if (!Number.isInteger(config.tts.maxBillableCharacters) || config.tts.maxBillableCharacters < 1 || config.tts.maxBillableCharacters > 1_000_000) {
    throw new Error('tts.maxBillableCharacters 必須介於 1 與 1000000。');
  }
  if (!(Number(config.tts.maxEstimatedCost) > 0)) throw new Error('tts.maxEstimatedCost 必須大於 0。');
  if (!Number.isInteger(config.tts.maxAudioBytesPerSlide) || config.tts.maxAudioBytesPerSlide < 1_048_576 || config.tts.maxAudioBytesPerSlide > 104_857_600) {
    throw new Error('tts.maxAudioBytesPerSlide 必須介於 1048576 與 104857600。');
  }
  if (!(Number(config.tts.estimatedCharactersPerMinute) >= 100 && Number(config.tts.estimatedCharactersPerMinute) <= 600)) {
    throw new Error('tts.estimatedCharactersPerMinute 必須介於 100 與 600。');
  }
  if (config.project.minSlides < 4 || config.project.maxSlides < config.project.minSlides) {
    throw new Error('project.minSlides／maxSlides 設定不合理。');
  }
  if (!(Number(config.project.targetMinutes) > 0) || Number(config.project.targetMinutes) > 240) throw new Error('project.targetMinutes 必須大於 0 且不超過 240。');
  if (!(Number(config.project.fundamentalsRatio) >= 0 && Number(config.project.fundamentalsRatio) <= 1)) throw new Error('project.fundamentalsRatio 必須介於 0 與 1。');
  if (!Number.isInteger(config.llm.maxSourceChars) || config.llm.maxSourceChars < 10000 || config.llm.maxSourceChars > 2_000_000) {
    throw new Error('llm.maxSourceChars 必須介於 10000 與 2000000。');
  }
  if (!Number.isInteger(config.llm.maxSelectedFiles) || config.llm.maxSelectedFiles < 1 || config.llm.maxSelectedFiles > 200) {
    throw new Error('llm.maxSelectedFiles 必須介於 1 與 200。');
  }
  if (!Number.isInteger(config.scan.maxFiles) || config.scan.maxFiles < 1 || config.scan.maxFiles > 100000) throw new Error('scan.maxFiles 必須介於 1 與 100000。');
  if (!Number.isInteger(config.scan.maxFileBytes) || config.scan.maxFileBytes < 1024 || config.scan.maxFileBytes > 10_485_760) {
    throw new Error('scan.maxFileBytes 必須介於 1024 與 10485760。');
  }
  if (config.slides.width !== 1920 || config.slides.height !== 1080) {
    throw new Error('MVP 固定輸出 1920×1080；請保留 slides.width=1920、height=1080。');
  }
  if (config.slides.renderProvider !== 'powerpoint') throw new Error('MVP 目前只支援 slides.renderProvider=powerpoint。');
  if (config.video.fps !== 30 || config.video.videoCodec !== 'libx264' || config.video.audioCodec !== 'aac') {
    throw new Error('MVP 發布規格固定為 30 FPS、libx264 與 AAC。');
  }
  if (config.video.burnSubtitles) throw new Error('MVP 尚未支援 burnSubtitles=true；請使用獨立 SRT／VTT。');
}

function createPaths(runRoot, projectId) {
  return {
    state: path.join(runRoot, 'state.json'),
    logs: path.join(runRoot, 'logs'),
    evidence: path.join(runRoot, 'evidence'),
    intermediate: path.join(runRoot, 'intermediate'),
    deck: path.join(runRoot, 'deck'),
    slides: path.join(runRoot, 'deck', 'slides'),
    audio: path.join(runRoot, 'audio'),
    ssml: path.join(runRoot, 'audio', 'ssml'),
    segments: path.join(runRoot, 'video', 'segments'),
    video: path.join(runRoot, 'video'),
    qa: path.join(runRoot, 'qa'),
    repoManifest: path.join(runRoot, 'evidence', 'repo-manifest.json'),
    sourceBundle: path.join(runRoot, 'evidence', 'source-bundle.txt'),
    evidenceManifest: path.join(runRoot, 'evidence', 'evidence.json'),
    coursePlan: path.join(runRoot, 'intermediate', 'course-plan.json'),
    narrationDisplay: path.join(runRoot, 'intermediate', 'narration-display.json'),
    narrationTts: path.join(runRoot, 'intermediate', 'narration-tts.json'),
    pronunciationAudit: path.join(runRoot, 'intermediate', 'pronunciation-audit.json'),
    egressReport: path.join(runRoot, 'intermediate', 'tts-egress-report.json'),
    deckFile: path.join(runRoot, 'deck', `${projectId}-教學投影片.pptx`),
    deckManifest: path.join(runRoot, 'deck', 'deck-manifest.json'),
    renderReport: path.join(runRoot, 'qa', 'powerpoint-render.json'),
    overflowReport: path.join(runRoot, 'qa', 'powerpoint-overflow.json'),
    videoManifest: path.join(runRoot, 'video', 'video-manifest.json'),
    subtitles: path.join(runRoot, 'video', `${projectId}-繁中字幕.srt`),
    webvtt: path.join(runRoot, 'video', `${projectId}-繁中字幕.vtt`),
    chapters: path.join(runRoot, 'video', `${projectId}-章節.txt`),
    finalVideo: path.join(runRoot, 'video', `${projectId}-教學影片.mp4`),
    qaReport: path.join(runRoot, 'qa', 'qa-report.json'),
  };
}

async function configTargetsRepo(target, resolvedRepoPath) {
  try {
    const existing = await readJson(target);
    if (!existing.repoPath) return false;
    const existingRepo = path.isAbsolute(existing.repoPath)
      ? path.normalize(existing.repoPath)
      : path.resolve(path.dirname(target), existing.repoPath);
    return existingRepo.toLowerCase() === resolvedRepoPath.toLowerCase();
  } catch {
    return false;
  }
}

export async function initializeConfig({ sourceTemplate, destination, repoPath, autoName = false }) {
  if (!repoPath || repoPath === true) throw new Error('init 必須提供 --repo <來源 repo 路徑>。');
  const resolvedRepoPath = path.resolve(String(repoPath));
  const repoStat = await fs.stat(resolvedRepoPath).catch(() => null);
  if (!repoStat?.isDirectory()) throw new Error(`--repo 不是可讀取的資料夾：${resolvedRepoPath}`);
  let target = path.resolve(destination || 'codereel.config.json');
  if (await pathExists(target)) {
    if (await configTargetsRepo(target, resolvedRepoPath)) return { path: target, created: false };
    if (!autoName) throw new Error(`不覆寫既有設定檔：${target}`);
    const directory = path.dirname(target);
    const repoName = safeName(path.basename(resolvedRepoPath), 'repository');
    target = path.join(directory, `${repoName}.config.json`);
    if (await pathExists(target) && !await configTargetsRepo(target, resolvedRepoPath)) {
      target = path.join(directory, `${repoName}-${sha256(resolvedRepoPath.toLowerCase()).slice(0, 8)}.config.json`);
    }
    if (await pathExists(target)) {
      if (await configTargetsRepo(target, resolvedRepoPath)) return { path: target, created: false };
      throw new Error(`不覆寫既有設定檔：${target}`);
    }
  }
  const template = sourceTemplate && await pathExists(sourceTemplate) ? await readJson(sourceTemplate) : {};
  const config = mergeDeep(defaults, template);
  config.repoPath = resolvedRepoPath;
  if (config.slides?.themeFile && !path.isAbsolute(config.slides.themeFile)) {
    const templateDirectory = sourceTemplate ? path.dirname(path.resolve(sourceTemplate)) : process.cwd();
    config.slides.themeFile = path.resolve(templateDirectory, config.slides.themeFile);
  }
  const configDirectory = path.dirname(target);
  const resolvedOutputRoot = path.resolve(configDirectory, config.outputRoot || './output');
  if (isPathInside(resolvedRepoPath, resolvedOutputRoot) || isPathInside(resolvedOutputRoot, resolvedRepoPath)) {
    config.outputRoot = path.join(path.dirname(resolvedRepoPath), `${safeName(path.basename(resolvedRepoPath), 'repository')}-codereel-output`);
  }
  await writeJsonAtomic(target, config);
  return { path: target, created: true };
}

export async function assertRepoReadable(config) {
  const stat = await fs.stat(config.repoPath).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`repoPath 不是可讀取的資料夾：${config.repoPath}`);
}
