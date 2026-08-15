import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { normalizeSlashes, readJson, sha256, writeJsonAtomic, writeTextAtomic } from './utils.mjs';

function decodeXml(value) {
  return String(value)
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function attributes(fragment) {
  const result = {};
  for (const match of fragment.matchAll(/([\w:.-]+)="([^"]*)"/gu)) result[match[1]] = decodeXml(match[2]);
  return result;
}

function relationships(xml) {
  const result = new Map();
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?\s*>/giu)) {
    const attrs = attributes(match[1]);
    if (attrs.Id) result.set(attrs.Id, attrs);
  }
  return result;
}

function resolveZipTarget(sourcePath, target) {
  const directory = path.posix.dirname(sourcePath);
  return path.posix.normalize(path.posix.join(directory, target)).replace(/^\//u, '');
}

function extractNotesBody(xml) {
  const shapes = [...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/giu)].map((match) => match[0]);
  const body = shapes.filter((shape) => /<p:ph\b[^>]*type="body"/iu.test(shape));
  const paragraphs = [];
  for (const shape of body) {
    for (const paragraph of shape.matchAll(/<a:p\b[\s\S]*?<\/a:p>/giu)) {
      const pieces = [...paragraph[0].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/giu)].map((match) => decodeXml(match[1]));
      const text = pieces.join('').trim();
      if (text) paragraphs.push(text);
    }
  }
  return paragraphs.join(' ').replace(/\s+/gu, ' ').trim();
}

export async function extractPptxNarration(pptxPath, notesSourceMarkers) {
  if (!Array.isArray(notesSourceMarkers) || notesSourceMarkers.length === 0) throw new Error('deck manifest 缺少 notes source markers。');
  const zip = await JSZip.loadAsync(await fs.readFile(pptxPath));
  const read = async (entry) => {
    const file = zip.file(entry);
    if (!file) throw new Error(`PPTX 缺少 entry：${entry}`);
    return await file.async('string');
  };
  const presentation = await read('ppt/presentation.xml');
  const presentationRels = relationships(await read('ppt/_rels/presentation.xml.rels'));
  const slideIds = [...presentation.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"[^>]*\/?\s*>/giu)].map((match) => match[1]);
  const narrations = [];
  for (let index = 0; index < slideIds.length; index += 1) {
    const slideRelationship = presentationRels.get(slideIds[index]);
    if (!slideRelationship?.Target) throw new Error(`第 ${index + 1} 頁找不到 slide relationship。`);
    const slidePath = resolveZipTarget('ppt/presentation.xml', slideRelationship.Target);
    const slideRelsPath = `${path.posix.dirname(slidePath)}/_rels/${path.posix.basename(slidePath)}.rels`;
    const slideRels = relationships(await read(slideRelsPath));
    const notesRelationship = [...slideRels.values()].find((item) => /\/notesSlide$/u.test(item.Type || ''));
    if (!notesRelationship?.Target) throw new Error(`第 ${index + 1} 頁沒有 speaker notes。`);
    const notesPath = resolveZipTarget(slidePath, notesRelationship.Target);
    const raw = extractNotesBody(await read(notesPath));
    const marker = notesSourceMarkers.find((item) => item.slide === index + 1)?.marker;
    if (!marker) throw new Error(`第 ${index + 1} 頁缺少 notes source marker。`);
    const markerText = `[CodeReelSources:${marker}]`;
    const markerAt = raw.indexOf(markerText);
    if (markerAt < 0) throw new Error(`第 ${index + 1} 頁 notes 的來源分隔標記遺失；請保留 ${markerText}。`);
    const display = raw.slice(0, markerAt)
      .replace(/^\s*中文註解\s*[：:]\s*/u, '')
      .replace(/\s+/gu, ' ')
      .trim();
    if (!display) throw new Error(`第 ${index + 1} 頁 notes 清理後為空。`);
    narrations.push({ slide: index + 1, display, notesPath: normalizeSlashes(notesPath), characters: [...display].length });
  }
  return narrations;
}

function escapedRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function makeSpokenText(display, pronunciation = {}) {
  let spoken = String(display);
  const audit = [];
  for (const replacement of pronunciation.replacements || []) {
    const from = String(replacement.from || '');
    if (!from) continue;
    if (replacement.phoneme) {
      const matches = spoken.match(new RegExp(escapedRegex(from), 'gu'))?.length || 0;
      if (matches) audit.push({ rule: from, phoneme: String(replacement.phoneme), matches });
      continue;
    }
    const pattern = new RegExp(escapedRegex(from), 'giu');
    const matches = spoken.match(pattern)?.length || 0;
    if (matches) {
      spoken = spoken.replace(pattern, String(replacement.to || ''));
      audit.push({ rule: from, replacement: String(replacement.to || ''), matches });
    }
  }
  if (pronunciation.underscoresAsPause) {
    const matches = spoken.match(/_/gu)?.length || 0;
    if (matches) {
      spoken = spoken.replace(/_+/gu, '，');
      audit.push({ rule: 'underscore', replacement: 'pause', matches });
    }
  }
  if (pronunciation.spellAcronyms) {
    spoken = spoken.replace(/\b[A-Z]{2,8}\b/gu, (token) => {
      if (token.includes(' ')) return token;
      audit.push({ rule: 'acronym', replacement: [...token].join(' '), matches: 1, token });
      return [...token].join(' ');
    });
  }
  return { spoken: spoken.replace(/\s{2,}/gu, ' ').trim(), audit };
}

export async function prepareNarration(config, plan) {
  const deckManifest = await readJson(config.paths.deckManifest);
  const extracted = await extractPptxNarration(config.paths.deckFile, deckManifest.notesSourceMarkers);
  if (extracted.length !== plan.slides.length) throw new Error(`PPTX notes ${extracted.length} 頁，plan ${plan.slides.length} 頁。`);
  const display = extracted.map((entry, index) => ({
    slide: entry.slide,
    slideId: plan.slides[index].id,
    title: plan.slides[index].title,
    display: entry.display,
    caption: entry.display,
    characters: entry.characters,
    notesPath: entry.notesPath,
  }));
  for (const entry of display) {
    const characters = [...entry.display.replace(/\s/gu, '')].length;
    if (characters < 40 || characters > 260) throw new Error(`第 ${entry.slide} 頁核准講稿 ${characters} 字，必須介於 40–260 字；尚未呼叫付費語音。`);
    if (/[这为发应现进过还从将与会学术体务网数线码档处实认验启]/u.test(entry.display)) {
      throw new Error(`第 ${entry.slide} 頁核准講稿含常見簡體字；尚未呼叫付費語音。`);
    }
  }
  if (config.tts.provider !== 'fixture') {
    const totalCharacters = display.reduce((sum, entry) => sum + [...entry.display.replace(/\s/gu, '')].length, 0);
    const estimatedMinutes = totalCharacters / config.tts.estimatedCharactersPerMinute
      + display.length * (config.video.preRollMs + config.video.tailPaddingMs) / 60000;
    const ratio = estimatedMinutes / config.project.targetMinutes;
    if (ratio < 0.45 || ratio > 1.8) {
      throw new Error(`核准講稿預估 ${estimatedMinutes.toFixed(1)} 分鐘，與 targetMinutes=${config.project.targetMinutes} 差距過大；尚未呼叫付費語音。`);
    }
  }
  const audit = [];
  const tts = display.map((entry) => {
    const transformed = makeSpokenText(entry.display, config.tts.pronunciation);
    audit.push({ slide: entry.slide, rules: transformed.audit });
    return { ...entry, spoken: transformed.spoken, spokenCharacters: [...transformed.spoken].length };
  });
  await writeJsonAtomic(config.paths.narrationDisplay, display);
  await writeJsonAtomic(config.paths.narrationTts, tts);
  await writeJsonAtomic(config.paths.pronunciationAudit, audit);
  return { display, tts, audit, hash: sha256(JSON.stringify(tts)) };
}

export function escapeSsml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function phonemeRules(pronunciation = {}) {
  return (pronunciation.replacements || [])
    .filter((item) => item?.phoneme && item?.from)
    .map((item) => ({ from: String(item.from), phoneme: String(item.phoneme) }))
    .sort((a, b) => b.from.length - a.from.length);
}

export function buildSsmlBody(spoken, pronunciation = {}) {
  const rules = phonemeRules(pronunciation);
  const text = String(spoken);
  if (rules.length === 0) return escapeSsml(text);
  const alphabet = escapeSsml(String(pronunciation.phonemeAlphabet || 'sapi'));
  const lookup = new Map(rules.map((rule) => [rule.from, rule.phoneme]));
  const pattern = new RegExp(rules.map((rule) => escapedRegex(rule.from)).join('|'), 'gu');
  let body = '';
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    body += escapeSsml(text.slice(index, match.index));
    body += `<phoneme alphabet="${alphabet}" ph="${escapeSsml(lookup.get(match[0]))}">${escapeSsml(match[0])}</phoneme>`;
    index = match.index + match[0].length;
  }
  return body + escapeSsml(text.slice(index));
}

export function buildSsml(spoken, config) {
  const body = buildSsmlBody(spoken, config.tts.pronunciation);
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-TW"><voice name="${escapeSsml(config.tts.voice)}"><prosody rate="${escapeSsml(config.tts.rate)}">${body}</prosody></voice></speak>`;
}

export async function writeSsmlFile(file, spoken, config) {
  const ssml = buildSsml(spoken, config);
  await writeTextAtomic(file, `${ssml}\n`);
  return ssml;
}
