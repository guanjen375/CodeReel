import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir, findCommand, readJson, runProcess } from './utils.mjs';

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
  if (config.slides.renderProvider !== 'powerpoint') {
    throw new Error(`MVP 目前只支援 slides.renderProvider=powerpoint，收到：${config.slides.renderProvider}`);
  }
  if (process.platform !== 'win32') throw new Error('PowerPoint renderer 目前需要 Windows。');
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
