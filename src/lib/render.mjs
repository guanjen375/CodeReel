import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureDir, findCommand, pathExists, readJson, runProcess, writeJsonAtomic } from './utils.mjs';

const LIBREOFFICE_CONVERT_TIMEOUT_MS = 10 * 60_000;
const LIBREOFFICE_PAGE_TIMEOUT_MS = 120_000;

const libreOfficeNames = [
  'soffice',
  'libreoffice',
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
  'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
];

export function defaultRenderProvider(platform = process.platform) {
  return platform === 'win32' ? 'powerpoint' : 'libreoffice';
}

async function findLibreOffice(config) {
  const configured = String(config.slides.libreOfficeExecutable || '').trim();
  for (const name of configured ? [configured] : libreOfficeNames) {
    const found = await findCommand(name);
    if (found) return found;
  }
  return null;
}

function libreOfficeMissing(config) {
  return [
    '找不到 LibreOffice（soffice）。',
    process.platform === 'darwin' ? '安裝：brew install --cask libreoffice' : '安裝：sudo apt install libreoffice-impress',
    '或把 slides.libreOfficeExecutable 設為 soffice 的完整路徑。',
  ].join('\n');
}

function pdfToPpmMissing() {
  return [
    '找不到 pdftoppm（poppler-utils）。',
    process.platform === 'darwin' ? '安裝：brew install poppler' : '安裝：sudo apt install poppler-utils',
    '或把 slides.pdfToPpmExecutable 設為 pdftoppm 的完整路徑。',
  ].join('\n');
}

async function renderWithLibreOffice(config, plan) {
  const [soffice, pdftoppm] = await Promise.all([
    findLibreOffice(config),
    findCommand(String(config.slides.pdfToPpmExecutable || '').trim() || 'pdftoppm'),
  ]);
  if (!soffice) throw new Error(libreOfficeMissing(config));
  if (!pdftoppm) throw new Error(pdfToPpmMissing());
  await ensureDir(config.paths.slides);
  await ensureDir(config.paths.qa);
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codereel-soffice-'));
  try {
    await runProcess(soffice, libreOfficeConvertArgs(config.paths.deckFile, workDir), {
      timeoutMs: LIBREOFFICE_CONVERT_TIMEOUT_MS,
    });
    const pdf = path.join(workDir, `${path.basename(config.paths.deckFile, path.extname(config.paths.deckFile))}.pdf`);
    if (!await pathExists(pdf)) throw new Error(`LibreOffice 沒有輸出 PDF：${pdf}`);

    const expected = plan.slides.length;
    for (let slide = 1; slide <= expected; slide += 1) {
      await renderPdfPage(pdftoppm, pdf, slide, path.join(config.paths.slides, `slide-${slide}`));
      await assertRenderedPage(path.join(config.paths.slides, `slide-${slide}.png`), slide);
    }
    const extra = path.join(workDir, 'extra');
    await renderPdfPage(pdftoppm, pdf, expected + 1, extra, true);
    if (await pathExists(`${extra}.png`)) throw new Error(`PDF 頁數多於課程計畫的 ${expected} 頁。`);

    await writeJsonAtomic(config.paths.renderReport, {
      schemaVersion: 1,
      provider: 'libreoffice',
      pptx: config.paths.deckFile,
      outputDir: config.paths.slides,
      slides: expected,
      width: 1920,
      height: 1080,
      generatedAt: new Date().toISOString(),
    });
    await writeJsonAtomic(config.paths.overflowReport, {
      schemaVersion: 1,
      provider: 'libreoffice',
      pptx: config.paths.deckFile,
      slides: expected,
      inspected: false,
      reason: 'libreoffice-renderer-has-no-text-metrics',
      checkedTextFrames: 0,
      issueCount: 0,
      issues: [],
      passed: true,
      generatedAt: new Date().toISOString(),
    });
    return {
      render: await readJson(config.paths.renderReport),
      overflow: await readJson(config.paths.overflowReport),
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

export function libreOfficeConvertArgs(deckFile, workDir) {
  return [
    '--headless', '--norestore', '--nolockcheck', '--nodefault', '--nofirststartwizard',
    `-env:UserInstallation=${pathToFileURL(path.join(workDir, 'profile')).href}`,
    '--convert-to', 'pdf', '--outdir', workDir, deckFile,
  ];
}

export function pdfToPpmArgs(pdf, page, outputPrefix, width = 1920, height = 1080) {
  return [
    '-png', '-f', String(page), '-l', String(page), '-singlefile',
    '-scale-to-x', String(width), '-scale-to-y', String(height), pdf, outputPrefix,
  ];
}

async function renderPdfPage(pdftoppm, pdf, page, outputPrefix, allowFailure = false) {
  await runProcess(pdftoppm, pdfToPpmArgs(pdf, page, outputPrefix), {
    timeoutMs: LIBREOFFICE_PAGE_TIMEOUT_MS, allowFailure,
  });
}

async function assertRenderedPage(file, slide) {
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size === 0) {
    throw new Error(`第 ${slide} 頁沒有渲染成 PNG：${file}`);
  }
}

const scriptsDir = fileURLToPath(new URL('../../scripts/', import.meta.url));
const POWERPOINT_RENDER_TIMEOUT_MS = 10 * 60_000;
const POWERPOINT_INSPECT_TIMEOUT_MS = 5 * 60_000;
const POWERPOINT_DOCTOR_TIMEOUT_MS = 60_000;
const POWERPOINT_LOCK = path.join(os.tmpdir(), 'codereel-powerpoint-com.lock');

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== 'ESRCH'; }
}

async function acquirePowerPointLock() {
  const token = crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(POWERPOINT_LOCK, 'wx');
      try { await handle.writeFile(`${JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })}\n`, 'utf8'); }
      finally { await handle.close(); }
      return async () => {
        const current = await readJson(POWERPOINT_LOCK).catch(() => null);
        if (current?.token === token) await fs.rm(POWERPOINT_LOCK, { force: true });
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const current = await readJson(POWERPOINT_LOCK).catch(() => null);
      if (processIsAlive(Number(current?.pid))) throw new Error(`另一個 CodeReel 工作正在使用 PowerPoint（PID ${current.pid}）。`);
      const stale = `${POWERPOINT_LOCK}.${process.pid}.${crypto.randomUUID()}.stale`;
      try { await fs.rename(POWERPOINT_LOCK, stale); await fs.rm(stale, { force: true }); }
      catch (renameError) { if (attempt === 1) throw renameError; }
    }
  }
  throw new Error('無法取得 PowerPoint 全域執行鎖。');
}

async function waitForPowerPointExit(powershell, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const check = await runProcess(powershell, [
      '-NoProfile', '-Command',
      "if (Get-Process -Name 'POWERPNT' -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }",
    ], { allowFailure: true, timeoutMs: 5000 });
    if (check.code === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('PowerPoint COM 已結束，但 POWERPNT 程序未在 30 秒內離開。');
}

export async function renderDeck(config, plan) {
  if (config.slides.renderProvider === 'libreoffice') return await renderWithLibreOffice(config, plan);
  if (config.slides.renderProvider !== 'powerpoint') {
    throw new Error(`不支援的 slides.renderProvider：${config.slides.renderProvider}`);
  }
  if (process.platform !== 'win32') {
    throw new Error('PowerPoint renderer 需要 Windows；其他平台請把 slides.renderProvider 設為 libreoffice。');
  }
  const release = await acquirePowerPointLock();
  try {
    const powershell = await findCommand('powershell.exe');
    if (!powershell) throw new Error('找不到 powershell.exe。');
    await ensureDir(config.paths.slides);
    await ensureDir(config.paths.qa);
    await runProcess(powershell, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptsDir, 'render-powerpoint.ps1'),
      '-PptxPath', config.paths.deckFile,
      '-OutputDir', config.paths.slides,
      '-ExpectedSlides', String(plan.slides.length),
      '-ReportPath', config.paths.renderReport,
      '-AllowedRoot', config.runRoot,
    ], { timeoutMs: POWERPOINT_RENDER_TIMEOUT_MS });
    await waitForPowerPointExit(powershell);
    await runProcess(powershell, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptsDir, 'inspect-powerpoint.ps1'),
      '-PptxPath', config.paths.deckFile,
      '-ExpectedSlides', String(plan.slides.length),
      '-ReportPath', config.paths.overflowReport,
      '-AllowedRoot', config.runRoot,
    ], { timeoutMs: POWERPOINT_INSPECT_TIMEOUT_MS });
    await waitForPowerPointExit(powershell);
    return {
      render: await readJson(config.paths.renderReport),
      overflow: await readJson(config.paths.overflowReport),
    };
  } finally {
    await release();
  }
}

export async function checkRenderer(config) {
  if (config.slides.renderProvider === 'libreoffice') return await checkLibreOffice(config);
  const report = await checkPowerPoint();
  return { ...report, provider: 'powerpoint', textFitInspected: true };
}

async function checkLibreOffice(config) {
  const [soffice, pdftoppm] = await Promise.all([
    findLibreOffice(config),
    findCommand(String(config.slides.pdfToPpmExecutable || '').trim() || 'pdftoppm'),
  ]);
  const nextSteps = [];
  if (!soffice) nextSteps.push(libreOfficeMissing(config));
  if (!pdftoppm) nextSteps.push(pdfToPpmMissing());
  return {
    available: Boolean(soffice && pdftoppm),
    provider: 'libreoffice',
    soffice,
    pdftoppm,
    textFitInspected: false,
    ...(nextSteps.length > 0 ? { nextSteps } : {}),
  };
}

export async function checkPowerPoint() {
  if (process.platform !== 'win32') return { available: false, reason: 'not-windows' };
  let release;
  try {
    release = await acquirePowerPointLock();
    const powershell = await findCommand('powershell.exe');
    if (!powershell) return { available: false, reason: 'powershell-missing' };
    const result = await runProcess(powershell, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptsDir, 'doctor-powerpoint.ps1'),
    ], { allowFailure: true, timeoutMs: POWERPOINT_DOCTOR_TIMEOUT_MS });
    if (result.timedOut) return { available: false, reason: 'powerpoint-check-timeout' };
    if (result.code !== 0) {
      try { return { ...JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1)), available: false, exitCode: result.code }; }
      catch { return { available: false, reason: 'powerpoint-check-failed', exitCode: result.code, error: result.stderr || result.stdout }; }
    }
    await waitForPowerPointExit(powershell);
    try { return JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1)); }
    catch { return { available: false, reason: result.stderr || result.stdout }; }
  } catch (error) {
    return { available: false, reason: 'powerpoint-lock-busy', error: error.message };
  } finally {
    if (release) await release();
  }
}
