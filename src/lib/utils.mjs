import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function stripBom(text) {
  return String(text).replace(/^\uFEFF/u, '');
}

export async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(directory) {
  await fs.mkdir(directory, { recursive: true });
}

export async function readJson(file) {
  return JSON.parse(stripBom(await fs.readFile(file, 'utf8')));
}

export async function writeJsonAtomic(file, value) {
  await writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

function temporarySibling(file, label = 'partial') {
  return `${file}.${process.pid}.${crypto.randomUUID()}.${label}`;
}

export async function replaceFileAtomic(source, target) {
  await ensureDir(path.dirname(target));
  try {
    await fs.rename(source, target);
    return;
  } catch (error) {
    if (!['EEXIST', 'EPERM', 'EACCES'].includes(error?.code) || !await pathExists(target)) throw error;
  }

  const backup = temporarySibling(target, 'backup');
  await fs.rename(target, backup);
  try {
    await fs.rename(source, target);
  } catch (error) {
    try {
      await fs.rename(backup, target);
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], `替換失敗，且無法還原既有檔案：${target}`);
    }
    throw error;
  }
  await fs.rm(backup, { force: true });
}

export async function writeTextAtomic(file, value, encoding = 'utf8') {
  await ensureDir(path.dirname(file));
  const partial = temporarySibling(file);
  try {
    await fs.writeFile(partial, value, encoding);
    await replaceFileAtomic(partial, file);
  } finally {
    await fs.rm(partial, { force: true });
  }
}

export async function copyFileAtomic(source, target) {
  await ensureDir(path.dirname(target));
  const partial = temporarySibling(target);
  try {
    await fs.copyFile(source, partial);
    await replaceFileAtomic(partial, target);
  } finally {
    await fs.rm(partial, { force: true });
  }
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function safeName(input, fallback = 'course') {
  const result = String(input || '')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/gu, '-')
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^[.\s-]+|[.\s-]+$/gu, '')
    .slice(0, 80);
  return result || fallback;
}

export function normalizeSlashes(input) {
  return String(input).replaceAll('\\', '/');
}

export function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function isLoopbackUrl(input) {
  try {
    const hostname = new URL(input).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function parseCliArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      result._.push(token);
      continue;
    }
    const equalAt = token.indexOf('=');
    if (equalAt > 2) {
      result[token.slice(2, equalAt)] = token.slice(equalAt + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
}

export async function runProcess(command, args = [], options = {}) {
  const {
    cwd,
    env,
    input,
    allowFailure = false,
    echo = false,
    maxOutputChars = 2_000_000,
    timeoutMs = 0,
  } = options;
  return await new Promise((resolve, reject) => {
    const inheritedEnv = {};
    const secretName = /(?:^|_)(?:API_?)?(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH)(?:$|_)/iu;
    const blockedNames = new Set([
      'AZURE_SPEECH_ENDPOINT', 'AZURE_SPEECH_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
      'GITHUB_TOKEN', 'GH_TOKEN', 'NPM_TOKEN', 'OPENAI_API_KEY', 'SSH_AUTH_SOCK',
    ]);
    for (const [key, value] of Object.entries(process.env)) {
      if (blockedNames.has(key.toUpperCase()) || secretName.test(key)) continue;
      inheritedEnv[key] = value;
    }
    const child = spawn(command, args, {
      cwd,
      env: { ...inheritedEnv, ...env },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let inputError = null;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs) : null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text) => {
      stdout = (stdout + text).slice(-maxOutputChars);
      if (echo) process.stdout.write(text);
    });
    child.stderr.on('data', (text) => {
      stderr = (stderr + text).slice(-maxOutputChars);
      if (echo) process.stderr.write(text);
    });
    child.stdin.on('error', (error) => {
      inputError = error;
    });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      if (allowFailure) resolve({ code: null, stdout, stderr, error });
      else reject(error);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const result = { code, stdout, stderr, timedOut };
      if (timedOut && !allowFailure) {
        const error = new Error(`${command} 執行逾時（${timeoutMs} ms）`);
        error.result = result;
        reject(error);
        return;
      }
      if (inputError && !allowFailure) {
        const error = new Error(`${command} 無法完整接收 stdin：${inputError.message}`);
        error.result = result;
        reject(error);
        return;
      }
      if (code === 0 || allowFailure) resolve(result);
      else {
        const error = new Error(`${command} 執行失敗（exit ${code}）\n${stderr || stdout}`.trim());
        error.result = result;
        reject(error);
      }
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export async function findCommand(command) {
  const requested = String(command || '').trim();
  if (!requested || requested.includes('\0')) return null;
  const windows = process.platform === 'win32';
  const hasDirectory = path.isAbsolute(requested) || requested.includes('/') || requested.includes('\\');
  const directories = hasDirectory
    ? ['']
    : String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const configuredExtensions = windows
    ? String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const hasExtension = Boolean(path.extname(requested));
  const extensions = windows && !hasExtension ? configuredExtensions : [''];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.resolve(directory || process.cwd(), `${requested}${extension}`);
      const stat = await fs.stat(candidate).catch(() => null);
      if (!stat?.isFile()) continue;
      if (!windows) {
        const executable = await fs.access(candidate, fs.constants.X_OK).then(() => true).catch(() => false);
        if (!executable) continue;
      }
      return candidate;
    }
  }
  return null;
}

export function secondsToClock(seconds, srt = false) {
  const milliseconds = Math.max(0, Math.round(Number(seconds) * 1000));
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1000);
  const ms = milliseconds % 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}${srt ? ',' : '.'}${pad(ms, 3)}`;
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds)));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}
