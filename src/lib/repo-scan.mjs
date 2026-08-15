import fs from 'node:fs/promises';
import path from 'node:path';
import { isPathInside, normalizeSlashes, sha256, writeJsonAtomic, writeTextAtomic } from './utils.mjs';

const specialTextFiles = new Set([
  'dockerfile', 'makefile', 'justfile', 'procfile', 'license', 'license.md', 'copying',
  'package.json', 'pyproject.toml', 'cargo.toml', 'go.mod', 'pom.xml', 'build.gradle',
]);
const sensitiveExtensions = new Set(['.pem', '.key', '.pfx', '.p12', '.jks', '.keystore']);

function isSensitive(relativePath, config) {
  const base = path.basename(relativePath).toLowerCase();
  const lower = normalizeSlashes(relativePath).toLowerCase();
  if (config.excludeFiles.map((entry) => entry.toLowerCase()).includes(base)) return true;
  if (sensitiveExtensions.has(path.extname(base))) return true;
  if (/(^|\/)(secrets?|credentials?)(\/|\.|$)/u.test(lower)) return true;
  return false;
}

function isIncludedFile(relativePath, config) {
  const base = path.basename(relativePath).toLowerCase();
  const extension = path.extname(base).toLowerCase();
  return specialTextFiles.has(base) || config.includeExtensions.map((item) => item.toLowerCase()).includes(extension);
}

function priorityFor(relativePath) {
  const value = normalizeSlashes(relativePath).toLowerCase();
  const base = path.basename(value);
  let score = 10;
  if (/^readme(?:\.|$)/u.test(base)) score += 120;
  if (['package.json', 'pyproject.toml', 'cargo.toml', 'go.mod', 'pom.xml'].includes(base)) score += 90;
  if (/(^|\/)(docs?|documentation)\//u.test(value)) score += 65;
  if (/(^|\/)(src|app|lib)\//u.test(value)) score += 50;
  if (/(^|\/)(scripts?|deploy|deployment|config)\//u.test(value)) score += 45;
  if (/(^|\/)(tests?|specs?)\//u.test(value)) score += 30;
  if (/(lock|\.min\.|generated|snapshot)/u.test(value)) score -= 80;
  return score;
}

function containsHighConfidenceSecret(text) {
  return [
    /-----BEGIN [^-]+ PRIVATE KEY-----/u,
    /\bAKIA[0-9A-Z]{16}\b/u,
    /\bgh[pousr]_[A-Za-z0-9]{36,}\b/u,
    /\bgithub_pat_[A-Za-z0-9_]{40,}\b/u,
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
    /\bAccountKey=[A-Za-z0-9+/=]{20,}/u,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/iu,
    /(?:Server|Data Source)=[^;\r\n]+;[^\r\n]*(?:User Id|UID)=[^;\r\n]+;[^\r\n]*(?:Password|Pwd)=[^;\r\n]{6,}/iu,
    /["'](?:password|client[_-]?secret|access[_-]?token|api[_-]?key)["']\s*:\s*["'][^"'\r\n]{12,}["']/iu,
  ].some((pattern) => pattern.test(text));
}

function safeRelativePath(relativePath) {
  const normalized = normalizeSlashes(relativePath);
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split('/').includes('..') || /[\u0000-\u001F\u007F]/u.test(normalized)) {
    throw new Error(`不安全的 repo 相對路徑：${JSON.stringify(relativePath)}`);
  }
  return normalized;
}

async function assertNoReparsePoint(rootReal, target) {
  const relative = path.relative(rootReal, path.resolve(target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    if (relative === '') return;
    throw new Error(`repo 路徑逃逸：${target}`);
  }
  let cursor = rootReal;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    const stat = await fs.lstat(cursor);
    if (stat.isSymbolicLink()) throw new Error(`repo 路徑包含 symlink／junction：${cursor}`);
  }
}

async function readStableRepoFile(rootReal, absolutePath, { maxBytes, expectedSha256 = null } = {}) {
  await assertNoReparsePoint(rootReal, absolutePath);
  const canonical = await fs.realpath(absolutePath);
  if (!isPathInside(rootReal, canonical)) throw new Error(`repo 檔案逃離來源根目錄：${absolutePath}`);
  const handle = await fs.open(canonical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`repo 項目不是一般檔案：${absolutePath}`);
    if (before.nlink > 1) throw new Error(`repo 檔案具有 hardlink，基於安全理由略過：${absolutePath}`);
    if (Number.isFinite(maxBytes) && before.size > maxBytes) throw new Error(`repo 檔案超過大小上限：${absolutePath}`);
    const buffer = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || buffer.length !== after.size) {
      throw new Error(`讀取期間 repo 檔案發生變更：${absolutePath}`);
    }
    const digest = sha256(buffer);
    if (expectedSha256 && digest !== expectedSha256) throw new Error(`蒐證期間 repo 檔案已變更：${absolutePath}`);
    return { buffer, stat: after, sha256: digest };
  } finally {
    await handle.close();
  }
}

export async function readVerifiedRepoFile(config, meta) {
  const rootReal = await fs.realpath(config.repoPath);
  const relativePath = safeRelativePath(meta.path);
  const absolutePath = path.join(rootReal, ...relativePath.split('/'));
  return await readStableRepoFile(rootReal, absolutePath, {
    maxBytes: config.scan.maxFileBytes,
    expectedSha256: meta.sha256,
  });
}

async function gitMetadata(repoReal) {
  const gitPath = path.join(repoReal, '.git');
  const gitStat = await fs.lstat(gitPath).catch(() => null);
  if (!gitStat) return { isGitRepository: false, commit: null, branch: null, dirty: null, dirtyCheck: 'not-a-git-repository' };
  if (!gitStat.isDirectory() || gitStat.isSymbolicLink()) {
    return { isGitRepository: true, commit: null, branch: null, dirty: null, dirtyCheck: 'external-or-linked-gitdir-not-read' };
  }
  const gitReal = await fs.realpath(gitPath);
  if (!isPathInside(repoReal, gitReal)) {
    return { isGitRepository: true, commit: null, branch: null, dirty: null, dirtyCheck: 'external-gitdir-not-read' };
  }
  const readMetadata = async (relative, maxBytes = 5 * 1024 * 1024) => {
    const target = path.join(gitReal, ...relative.split('/'));
    return (await readStableRepoFile(gitReal, target, { maxBytes })).buffer.toString('utf8').trim();
  };
  const head = await readMetadata('HEAD', 4096).catch(() => '');
  let commit = null;
  let branch = null;
  if (/^[0-9a-f]{40,64}$/iu.test(head)) {
    commit = head.toLowerCase();
  } else if (head.startsWith('ref: ')) {
    const reference = normalizeSlashes(head.slice(5).trim());
    if (/^refs\/heads\/[0-9A-Za-z._\/-]+$/u.test(reference) && !reference.split('/').includes('..')) {
      branch = reference.slice('refs/heads/'.length);
      const loose = await readMetadata(reference, 4096).catch(() => '');
      if (/^[0-9a-f]{40,64}$/iu.test(loose)) commit = loose.toLowerCase();
      if (!commit) {
        const packed = await readMetadata('packed-refs').catch(() => '');
        const line = packed.split(/\r?\n/u).find((entry) => entry.endsWith(` ${reference}`));
        const packedCommit = line?.split(' ')[0];
        if (/^[0-9a-f]{40,64}$/iu.test(packedCommit || '')) commit = packedCommit.toLowerCase();
      }
    }
  }
  return {
    isGitRepository: true,
    commit,
    branch,
    dirty: null,
    dirtyCheck: 'not-performed-to-preserve-read-only-input',
    status: [],
  };
}

export async function scanRepository(config) {
  const files = [];
  const candidates = [];
  const skipped = { sensitive: [], secretContent: [], symlink: [], hardlink: [], tooLarge: [], unsupported: [] };
  const repoReal = await fs.realpath(config.repoPath);
  const excludedDirectories = new Set(config.scan.excludeDirectories.map((entry) => entry.toLowerCase()));
  const excludedAbsoluteDirectories = [config.outputRoot, config.cacheRoot]
    .filter(Boolean)
    .map((entry) => path.resolve(entry))
    .filter((entry) => isPathInside(repoReal, entry));
  const maxEntries = Math.max(config.scan.maxFiles * 20, config.scan.maxFiles + 100);
  let visitedEntries = 0;
  let entryLimitExceeded = false;

  async function walk(directory, relativeDirectory = '') {
    if (entryLimitExceeded) return;
    const handle = await fs.opendir(directory);
    for await (const entry of handle) {
      if (visitedEntries >= maxEntries) {
        entryLimitExceeded = true;
        return;
      }
      visitedEntries += 1;
      const relativePath = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
      const absolutePath = path.join(directory, entry.name);
      const current = await fs.lstat(absolutePath).catch(() => null);
      if (!current) continue;
      if (current.isSymbolicLink()) {
        skipped.symlink.push(normalizeSlashes(relativePath));
        continue;
      }
      if (current.isDirectory()) {
        if (excludedDirectories.has(entry.name.toLowerCase())) continue;
        const canonical = await fs.realpath(absolutePath);
        if (!isPathInside(repoReal, canonical)) {
          skipped.symlink.push(normalizeSlashes(relativePath));
          continue;
        }
        if (excludedAbsoluteDirectories.some((excluded) => isPathInside(excluded, canonical))) continue;
        await walk(canonical, relativePath);
        continue;
      }
      if (!current.isFile()) continue;
      const normalized = safeRelativePath(relativePath);
      if (current.nlink > 1) {
        skipped.hardlink.push(normalized);
        continue;
      }
      if (isSensitive(relativePath, config.scan)) {
        skipped.sensitive.push(normalized);
        continue;
      }
      if (!isIncludedFile(relativePath, config.scan)) {
        skipped.unsupported.push(normalized);
        continue;
      }
      if (current.size > config.scan.maxFileBytes) {
        skipped.tooLarge.push(normalized);
        continue;
      }
      candidates.push({ path: normalized, absolutePath, priority: priorityFor(relativePath) });
    }
  }

  await walk(repoReal);
  if (entryLimitExceeded) {
    throw new Error(`repo 項目超過安全上限 ${maxEntries}；請增加排除目錄或縮小輸入範圍。`);
  }
  candidates.sort((a, b) => b.priority - a.priority || a.path.localeCompare(b.path, 'en'));
  let processedCandidates = 0;
  for (const candidate of candidates) {
      if (files.length >= config.scan.maxFiles) break;
      processedCandidates += 1;
      const { buffer, stat, sha256: digest } = await readStableRepoFile(repoReal, candidate.absolutePath, { maxBytes: config.scan.maxFileBytes });
      if (buffer.includes(0)) {
        skipped.unsupported.push(candidate.path);
        continue;
      }
      const text = buffer.toString('utf8').replace(/^\uFEFF/u, '');
      if (containsHighConfidenceSecret(text)) {
        skipped.secretContent.push(candidate.path);
        continue;
      }
      files.push({
        path: candidate.path,
        bytes: stat.size,
        lines: text.split(/\r?\n/u).length,
        sha256: digest,
        priority: candidate.priority,
      });
  }

  files.sort((a, b) => b.priority - a.priority || a.path.localeCompare(b.path, 'en'));
  for (const values of Object.values(skipped)) values.sort((a, b) => a.localeCompare(b, 'en'));
  return {
    schemaVersion: 1,
    repoPath: config.repoPath,
    scannedAt: new Date().toISOString(),
    git: await gitMetadata(repoReal),
    files,
    skipped,
    limits: {
      maxFiles: config.scan.maxFiles,
      maxFileBytes: config.scan.maxFileBytes,
      reachedFileLimit: processedCandidates < candidates.length,
      maxEntries,
      visitedEntries,
      reachedEntryLimit: false,
    },
  };
}

export function fallbackSourceSelection(manifest, maxFiles) {
  const selected = [];
  const seen = new Set();
  const add = (file) => {
    if (!file || seen.has(file.path) || selected.length >= maxFiles) return;
    seen.add(file.path);
    selected.push(file.path);
  };
  manifest.files.filter((file) => /^readme(?:\.|$)/iu.test(path.basename(file.path))).forEach(add);
  manifest.files.filter((file) => file.priority >= 80).forEach(add);
  manifest.files.filter((file) => file.priority >= 50).forEach(add);
  manifest.files.forEach(add);
  return selected;
}

function redactLiteralSecrets(text) {
  return text
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/giu, '[REDACTED PRIVATE KEY]')
    .replace(/((?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["'])([^"'\r\n]{6,})(["'])/giu, '$1[REDACTED]$3')
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{20,}\b/giu, '$1[REDACTED]')
    .replace(/((?:AccountKey|Password|Pwd)=)[^;\r\n]+/giu, '$1[REDACTED]');
}

export async function buildSourceBundle(config, manifest, selectedPaths) {
  const lookup = new Map(manifest.files.map((file) => [file.path, file]));
  let output = '';
  const used = [];
  for (const relativePath of selectedPaths) {
    const meta = lookup.get(normalizeSlashes(relativePath));
    if (!meta || config.llm.maxSourceChars - output.length < 500) continue;
    const verified = await readVerifiedRepoFile(config, meta);
    const text = redactLiteralSecrets(verified.buffer.toString('utf8').replace(/^\uFEFF/u, ''));
    const header = `${output ? '\n' : ''}===== FILE ${meta.path} (${meta.lines} lines, sha256:${meta.sha256}) =====\n`;
    if (output.length + header.length >= config.llm.maxSourceChars) continue;
    let numbered = '';
    let includedChars = 0;
    const lines = text.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const row = `${index ? '\n' : ''}${String(index + 1).padStart(5, ' ')} | ${lines[index]}`;
      if (output.length + header.length + numbered.length + row.length > config.llm.maxSourceChars) break;
      numbered += row;
      includedChars += lines[index].length + (index ? 1 : 0);
    }
    if (!numbered) continue;
    output += header + numbered;
    used.push({ path: meta.path, includedChars, truncated: includedChars < text.length, sha256: meta.sha256 });
  }
  return { text: output, used, totalChars: output.length };
}

export async function saveScanArtifacts(config, manifest, bundle = null) {
  await writeJsonAtomic(config.paths.repoManifest, manifest);
  if (bundle) await writeTextAtomic(config.paths.sourceBundle, bundle.text);
}
