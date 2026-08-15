import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import PptxGenJS from 'pptxgenjs';
import JSZip from 'jszip';
import { readJson, replaceFileAtomic, safeName, writeJsonAtomic } from './utils.mjs';

const SLIDE_W = 13.333;
const SLIDE_H = 7.5;
const CODE_UNIT_RATIO = 0.6;
const BODY_UNIT_RATIO = 0.5;
const LINE_HEIGHT_RATIO = 1.25;
const CODE_MIN_PT = 8;
const BODY_MIN_PT = 12;
const FIT_SAFETY = 0.92;
const WIDE_CHARACTER = /[ᄀ-ᅟ⺀-꓏ꥠ-꥿가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦]/u;

export function displayWidth(text) {
  let width = 0;
  for (const character of String(text ?? '')) width += WIDE_CHARACTER.test(character) ? 2 : 1;
  return width;
}

function wrappedRows(lines, unitsPerRow) {
  return lines.reduce((total, line) => total + Math.max(1, Math.ceil(displayWidth(line) / unitsPerRow)), 0);
}

export function softWrap(lines, unitsPerRow, indent = '    ') {
  const limit = Math.max(12, unitsPerRow);
  const rows = [];
  for (const line of lines) {
    let rest = String(line);
    let prefix = '';
    while (displayWidth(prefix + rest) > limit) {
      let cut = 0;
      let width = displayWidth(prefix);
      for (const character of rest) {
        const next = width + displayWidth(character);
        if (next > limit) break;
        width = next;
        cut += character.length;
      }
      if (cut <= 0) cut = 1;
      const space = rest.slice(0, cut).lastIndexOf(' ');
      const breakAt = space > limit / 3 ? space + 1 : cut;
      rows.push((prefix + rest.slice(0, breakAt)).trimEnd());
      rest = rest.slice(breakAt);
      prefix = indent;
    }
    if (rest || !prefix) rows.push(prefix + rest);
  }
  return rows;
}

export function fitFontSize(lines, { widthInches, heightInches, basePt, minPt, unitRatio, paraSpacePt = 0, step = 0.5, avoidWrap = false }) {
  const widthPt = widthInches * 72 * FIT_SAFETY;
  const heightPt = heightInches * 72 * FIT_SAFETY;
  const longest = lines.reduce((max, line) => Math.max(max, displayWidth(line)), 1);
  let size = avoidWrap ? Math.min(basePt, widthPt / (unitRatio * longest)) : basePt;
  while (size > minPt) {
    const unitsPerRow = Math.max(1, Math.floor(widthPt / (unitRatio * size)));
    const rows = wrappedRows(lines, unitsPerRow);
    if (rows * (size * LINE_HEIGHT_RATIO + paraSpacePt * (size / basePt)) <= heightPt) break;
    size -= step;
  }
  return Math.max(minPt, Math.round(size * 2) / 2);
}

async function validateDeckArchive(buffer, expectedSlides, notesSourceMarkers) {
  const archive = await JSZip.loadAsync(buffer);
  for (const required of ['[Content_Types].xml', 'ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels']) {
    if (!archive.file(required)) throw new Error(`產生的 PPTX 缺少必要 entry：${required}`);
  }
  const presentation = await archive.file('ppt/presentation.xml').async('string');
  const slideCount = [...presentation.matchAll(/<p:sldId\b/giu)].length;
  if (slideCount !== expectedSlides) throw new Error(`產生的 PPTX 頁數 ${slideCount}，預期 ${expectedSlides}。`);
  for (let index = 1; index <= expectedSlides; index += 1) {
    const slidePath = `ppt/slides/slide${index}.xml`;
    const notesPath = `ppt/notesSlides/notesSlide${index}.xml`;
    if (!archive.file(slidePath)) throw new Error(`產生的 PPTX 缺少投影片：${slidePath}`);
    const notes = archive.file(notesPath);
    if (!notes) throw new Error(`產生的 PPTX 缺少 speaker notes：${notesPath}`);
    const marker = notesSourceMarkers.find((item) => item.slide === index)?.marker;
    if (!marker || !(await notes.async('string')).includes(`[CodeReelSources:${marker}]`)) {
      throw new Error(`產生的 PPTX 第 ${index} 頁缺少來源分隔標記。`);
    }
  }
}

function addText(slide, text, options) {
  slide.addText(String(text ?? ''), {
    margin: 0,
    breakLine: false,
    valign: 'mid',
    fit: 'shrink',
    ...options,
  });
}

function addBase(slide, pptx, theme, plan, item, index, count, fonts) {
  const c = theme.colors;
  slide.background = { color: c.background };
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.14, h: SLIDE_H, line: { color: c.accent, transparency: 100 }, fill: { color: c.accent } });
  addText(slide, String(item.section || '教學').toUpperCase(), {
    x: 0.55, y: 0.25, w: 2.7, h: 0.25,
    fontFace: fonts.body, fontSize: 11, bold: true, charSpacing: 1.2, color: c.accent,
  });
  addText(slide, item.title, {
    x: 0.55, y: 0.54, w: 11.9, h: 0.7,
    fontFace: fonts.body, fontSize: theme.typography.slideTitlePt, bold: true, color: c.text,
  });
  if (item.subtitle) {
    addText(slide, item.subtitle, {
      x: 0.58, y: 1.3, w: 11.4, h: 0.32,
      fontFace: fonts.body, fontSize: 16, color: c.muted,
    });
  }
  slide.addShape(pptx.ShapeType.line, { x: 0.58, y: 6.98, w: 12.1, h: 0, line: { color: c.line, width: 0.7 } });
  addText(slide, plan.projectTitle, {
    x: 0.58, y: 7.05, w: 5.5, h: 0.18,
    fontFace: fonts.body, fontSize: theme.typography.footerPt, color: c.muted,
  });
  addText(slide, `${String(index + 1).padStart(2, '0')} / ${String(count).padStart(2, '0')}`, {
    x: 11.55, y: 7.05, w: 1.1, h: 0.18,
    fontFace: fonts.code, fontSize: theme.typography.footerPt, color: c.muted, align: 'right',
  });
}

function addBulletList(slide, pptx, theme, bullets, options = {}) {
  const c = theme.colors;
  const x = options.x ?? 0.72;
  const y = options.y ?? 1.75;
  const w = options.w ?? 5.5;
  const rowH = options.rowH ?? 0.82;
  const fontSize = options.fontSize ?? theme.typography.bodyPt;
  bullets.slice(0, 5).forEach((bullet, index) => {
    const rowY = y + index * rowH;
    slide.addShape(pptx.ShapeType.line, { x, y: rowY + rowH - 0.08, w, h: 0, line: { color: c.line, transparency: 35, width: 0.5 } });
    addText(slide, String(index + 1).padStart(2, '0'), {
      x, y: rowY + 0.06, w: 0.48, h: 0.35,
      fontFace: options.codeFont || 'Cascadia Mono', fontSize: 13, bold: true, color: c.accent,
    });
    addText(slide, bullet, {
      x: x + 0.62, y: rowY, w: w - 0.62, h: rowH - 0.08,
      fontFace: options.bodyFont || 'Microsoft JhengHei', color: c.text, breakLine: true,
      fontSize: fitFontSize([bullet], {
        widthInches: w - 0.72, heightInches: rowH - 0.14, basePt: fontSize,
        minPt: Math.min(BODY_MIN_PT, fontSize), unitRatio: BODY_UNIT_RATIO, step: 1, avoidWrap: true,
      }),
    });
  });
}

function addCodePanel(slide, pptx, theme, code, fonts, options = {}) {
  const c = theme.colors;
  const x = options.x ?? 6.65;
  const y = options.y ?? 1.78;
  const w = options.w ?? 5.9;
  const h = options.h ?? 4.7;
  slide.addShape(pptx.ShapeType.roundRect, {
    x, y, w, h, rectRadius: 0.06,
    line: { color: c.line, width: 1 }, fill: { color: c.codeBackground },
  });
  slide.addShape(pptx.ShapeType.line, { x: x + 0.25, y: y + 0.52, w: w - 0.5, h: 0, line: { color: c.line, width: 0.6 } });
  addText(slide, code.caption || code.language || '操作', {
    x: x + 0.27, y: y + 0.14, w: w - 0.54, h: 0.22,
    fontFace: fonts.body, fontSize: 12, bold: true, color: c.accentAlt,
  });
  const numbered = String(code.text || '').split(/\r?\n/u).map((line, index) => `${String(index + 1).padStart(2, ' ')}  ${line}`);
  const basePt = theme.typography.codePt;
  const fontSize = fitFontSize(numbered, {
    widthInches: w - 0.62, heightInches: h - 1, basePt,
    minPt: CODE_MIN_PT, unitRatio: CODE_UNIT_RATIO, paraSpacePt: 5, avoidWrap: true,
  });
  const unitsPerRow = Math.floor((w - 0.62) * 72 * FIT_SAFETY / (CODE_UNIT_RATIO * fontSize));
  addText(slide, softWrap(numbered, unitsPerRow).join('\n'), {
    x: x + 0.28, y: y + 0.68, w: w - 0.56, h: h - 0.94,
    fontFace: fonts.code, fontSize, color: c.codeText,
    valign: 'top', breakLine: true, paraSpaceAfterPt: Math.max(1, Math.round(5 * (fontSize / basePt))), margin: 0.03,
  });
}

function addCover(slide, pptx, theme, plan, item, fonts, count) {
  const c = theme.colors;
  slide.background = { color: c.background };
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: SLIDE_W, h: 0.16, line: { transparency: 100 }, fill: { color: c.accent } });
  addText(slide, item.section || 'PROJECT TRAINING', {
    x: 0.85, y: 0.75, w: 5.8, h: 0.32,
    fontFace: fonts.code, fontSize: 14, bold: true, charSpacing: 1.8, color: c.accent,
  });
  addText(slide, item.title || plan.projectTitle, {
    x: 0.82, y: 1.42, w: 11.35, h: 1.25,
    fontFace: fonts.body, fontSize: theme.typography.deckTitlePt, bold: true, color: c.text,
  });
  addText(slide, item.subtitle || plan.courseTitle, {
    x: 0.86, y: 2.86, w: 10.6, h: 0.65,
    fontFace: fonts.body, fontSize: theme.typography.subheadingPt, color: c.muted,
  });
  slide.addShape(pptx.ShapeType.line, { x: 0.86, y: 4.08, w: 4.3, h: 0, line: { color: c.accentAlt, width: 2 } });
  addText(slide, plan.summary, {
    x: 0.86, y: 4.32, w: 9.15, h: 1.08,
    fontFace: fonts.body, fontSize: 18, color: c.text, breakLine: true,
  });
  addText(slide, `${count} 頁 · 逐頁旁白 · 可追溯證據`, {
    x: 0.86, y: 6.65, w: 5.4, h: 0.3,
    fontFace: fonts.code, fontSize: 11, color: c.muted,
  });
}

function addAgenda(slide, pptx, theme, item, fonts) {
  const c = theme.colors;
  const bullets = item.bullets.slice(0, 5);
  const startY = 1.82;
  const rowH = Math.min(1.02, 4.85 / Math.max(bullets.length, 1));
  bullets.forEach((bullet, index) => {
    const y = startY + index * rowH;
    addText(slide, String(index + 1).padStart(2, '0'), {
      x: 0.82, y: y + 0.08, w: 0.72, h: 0.48,
      fontFace: fonts.code, fontSize: 24, bold: true, color: index === 0 ? c.accent : c.accentAlt,
    });
    slide.addShape(pptx.ShapeType.line, { x: 1.68, y: y + rowH - 0.08, w: 10.55, h: 0, line: { color: c.line, width: 0.8 } });
    addText(slide, bullet, {
      x: 1.68, y, w: 10.45, h: rowH - 0.12,
      fontFace: fonts.body, fontSize: 18, bold: true, color: c.text, valign: 'mid', breakLine: true,
    });
  });
}

function addSummary(slide, pptx, theme, item, fonts) {
  const c = theme.colors;
  item.bullets.slice(0, 5).forEach((bullet, index) => {
    const characters = [...String(bullet || '')].length;
    const fontSize = characters > 72 ? 16 : (characters > 52 ? 18 : 20);
    const y = 1.66 + index * 0.98;
    slide.addShape(pptx.ShapeType.line, { x: 0.78, y: y + 0.76, w: 11.6, h: 0, line: { color: c.line, width: 0.7 } });
    addText(slide, String(index + 1), {
      x: 0.8, y, w: 0.7, h: 0.62,
      fontFace: fonts.code, fontSize: 28, bold: true, color: c.accent,
    });
    addText(slide, bullet, {
      x: 1.65, y, w: 10.85, h: 0.78,
      fontFace: fonts.body, fontSize, bold: true, color: c.text, breakLine: true,
    });
  });
}

function sourceNote(slide) {
  return slide.evidence.map((item) => `- ${item.path}:${item.startLine}-${item.endLine} — ${item.claim}`).join('\n');
}

export async function buildDeck(config, plan) {
  const theme = await readJson(config.slides.themeFile);
  const fonts = { body: config.slides.fontFace, code: config.slides.codeFontFace };
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'CODEREEL_WIDE', width: SLIDE_W, height: SLIDE_H });
  pptx.layout = 'CODEREEL_WIDE';
  pptx.author = 'CodeReel';
  pptx.company = 'CodeReel';
  pptx.subject = `${plan.projectTitle} 教學`;
  pptx.title = plan.courseTitle;
  pptx.lang = 'zh-TW';
  pptx.theme = {
    headFontFace: fonts.body,
    bodyFontFace: fonts.body,
    lang: 'zh-TW',
  };
  pptx.defineSlideMaster({
    title: 'CODEREEL_BASE',
    background: { color: theme.colors.background },
    objects: [],
  });

  const notesSourceMarkers = [];
  plan.slides.forEach((item, index) => {
    const slide = index === 0 ? pptx.addSlide() : pptx.addSlide('CODEREEL_BASE');
    if (item.kind === 'cover') {
      addCover(slide, pptx, theme, plan, item, fonts, plan.slides.length);
    } else {
      addBase(slide, pptx, theme, plan, item, index, plan.slides.length, fonts);
      if (item.kind === 'agenda') addAgenda(slide, pptx, theme, item, fonts);
      else if (item.kind === 'summary') addSummary(slide, pptx, theme, item, fonts);
      else if (item.code) {
        addBulletList(slide, pptx, theme, item.bullets, { x: 0.72, y: 1.78, w: 5.35, rowH: 0.88, bodyFont: fonts.body, codeFont: fonts.code });
        addCodePanel(slide, pptx, theme, item.code, fonts);
      } else if (item.kind === 'warning') {
        slide.addShape(pptx.ShapeType.line, { x: 0.82, y: 1.78, w: 0, h: 4.55, line: { color: theme.colors.danger, width: 4 } });
        addBulletList(slide, pptx, theme, item.bullets, { x: 1.18, y: 1.82, w: 10.7, rowH: 0.86, bodyFont: fonts.body, codeFont: fonts.code, fontSize: 21 });
      } else {
        addBulletList(slide, pptx, theme, item.bullets, { x: 0.85, y: 1.75, w: 11.25, rowH: 0.9, bodyFont: fonts.body, codeFont: fonts.code, fontSize: item.kind === 'steps' ? 20 : 19 });
      }
    }
    const marker = crypto.randomUUID();
    notesSourceMarkers.push({ slide: index + 1, marker });
    const notes = `${item.narration.trim()}\n\n[CodeReelSources:${marker}]\n${sourceNote(item)}`;
    slide.addNotes(notes);
  });

  await fs.mkdir(config.paths.deck, { recursive: true });
  const partial = `${config.paths.deckFile}.${process.pid}.${crypto.randomUUID()}.partial.pptx`;
  try {
    await pptx.writeFile({ fileName: partial, compression: true });
    await validateDeckArchive(await fs.readFile(partial), plan.slides.length, notesSourceMarkers);
    await replaceFileAtomic(partial, config.paths.deckFile);
  } finally {
    await fs.rm(partial, { force: true });
  }
  const deckManifest = {
    schemaVersion: 1,
    projectTitle: plan.projectTitle,
    courseTitle: plan.courseTitle,
    slides: plan.slides.length,
    output: config.paths.deckFile,
    theme: theme.name,
    fonts,
    slideSize: { widthInches: SLIDE_W, heightInches: SLIDE_H },
    notesSourceMarkers,
    generatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(config.paths.deckManifest, deckManifest);
  return deckManifest;
}

export function finalArtifactName(plan) {
  return safeName(plan.courseTitle || plan.projectTitle, '教學投影片');
}
