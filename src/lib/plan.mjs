import { normalizeSlashes, sha256, writeJsonAtomic } from './utils.mjs';
import { readVerifiedRepoFile } from './repo-scan.mjs';

const allowedKinds = new Set(['cover', 'agenda', 'concept', 'steps', 'code', 'warning', 'summary']);
const forbiddenPhrases = ['建議講者', '講者可以', '本頁只抓', '本頁要', '這張投影片要', '剛接觸專案者應該'];
const dangerousCommandPatterns = [
  /(?:curl|wget|Invoke-WebRequest)\b[^\r\n]*(?:\||;|&&)\s*(?:sh|bash|zsh|powershell|pwsh|cmd)\b/iu,
  /\b(?:rm\s+-rf|Remove-Item\b[^\r\n]*-(?:Recurse|Force)|del\s+\/s|rmdir\s+\/s|format\s+[A-Za-z]:)/iu,
  /\b(?:Invoke-Expression|iex|powershell|pwsh)\b[^\r\n]*(?:-enc(?:odedcommand)?|-ExecutionPolicy\s+Bypass)/iu,
  /\b(?:cat|type|Get-Content)\b[^\r\n]*(?:\.env|id_rsa|credentials|service-account|\/etc\/(?:passwd|shadow))/iu,
];
const unstructuredCommandPatterns = [
  /(?:^|\s)(?:npm|pnpm|yarn)\s+(?:ci|install|run|exec|test|build|start)\b/iu,
  /(?:^|\s)node\s+(?:--?[\w-]+|\.?[\\/]|[\w.-]+\.(?:[cm]?js|ts))\b/iu,
  /(?:^|\s)git\s+(?:clone|checkout|switch|pull|push|fetch|merge|rebase|status|log|diff|add|commit)\b/iu,
  /(?:^|\s)ollama\s+(?:pull|run|serve|list|show|ps|rm)\b/iu,
  /(?:^|\s)winget\s+install\b/iu,
  /(?:^|\s)(?:ffmpeg|ffprobe)\s+-[\w-]+\b/iu,
  /(?:^|\s)(?:powershell|pwsh)\s+-[\w-]+\b/iu,
  /(?:^|\s)cmd\s+\/[ck]\b/iu,
  /(?:^|\s)(?:bash|sh)\s+(?:-[a-z]+\b|\.?[\\/][^\s]+)/iu,
  /(?:^|\s)(?:curl|wget|Invoke-WebRequest|Remove-Item|rm|del|sudo)\b\s+(?:--?[\w-]+|https?:\/\/|[^\s]+(?:\||&&|;|>))/iu,
];
const promotableCommandPatterns = [
  /\b(?:npm|pnpm|yarn)\s+(?:ci|install|run|exec|test|build|start)(?:\s+(?:--?[A-Za-z0-9][\w-]*(?:=[^\s，。；]+)?|[A-Za-z0-9@._:/\\-]+)){0,8}/giu,
  /\bollama\s+(?:pull|run|serve|list|show|ps)(?:\s+[A-Za-z0-9@._:/-]+){0,3}/giu,
  /\bwinget\s+install(?:\s+(?:--?[A-Za-z0-9][\w-]*(?:=[^\s，。；]+)?|[A-Za-z0-9@._:/\\-]+)){0,12}/giu,
  /\b(?:node|ffmpeg|ffprobe)\s+--?[A-Za-z0-9][\w-]*/giu,
  /\bgit\s+(?:clone|checkout|switch|pull|fetch|status|log|diff)(?:\s+(?:--?[A-Za-z0-9][\w-]*|[A-Za-z0-9@._:/\\-]+)){0,8}/giu,
];
const commonSimplifiedCharacters = /[这为发应现进过还从将与会学术体务网数线码档处实认验启]/u;
const audienceReferencePattern = /適用對象|使用者|讀者|觀眾|客戶|初學者|新手|學習者|剛接觸(?:專案)?者/iu;

function assertTraditionalProse(value, location) {
  if (commonSimplifiedCharacters.test(String(value || ''))) throw new Error(`${location} 偵測到常見簡體字；請改為繁體中文。`);
}

function neutralizeAudienceReferences(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/本課程專為/gu, '本課程用於')
    .replace(/(?:，|。)?(?:適用於|適合)(?:任何)?[^，。]*(?:使用者|讀者|觀眾|客戶|初學者|新手|學習者|剛接觸(?:專案)?者)[，。]?/giu, '。')
    .replace(/(?:使用者|讀者|觀眾|客戶|初學者|新手|學習者|剛接觸(?:專案)?者)/giu, '')
    .replace(/。{2,}/gu, '。')
    .trim();
}

function truncateDisplayText(value, maxCharacters) {
  const characters = [...String(value || '').trim()];
  if (characters.length <= maxCharacters) return characters.join('');
  return `${characters.slice(0, maxCharacters - 1).join('').replace(/[，、；：\s]+$/u, '')}。`;
}

export function validateSelection(value, manifest, maxFiles) {
  if (!value || !Array.isArray(value.selectedPaths)) throw new Error('selectedPaths 必須是陣列。');
  if (value.selectedPaths.length === 0 || value.selectedPaths.length > maxFiles) {
    throw new Error(`selectedPaths 必須介於 1 與 ${maxFiles}。`);
  }
  const known = new Set(manifest.files.map((file) => file.path));
  for (const selected of value.selectedPaths) {
    if (!known.has(normalizeSlashes(selected))) throw new Error(`模型選了不存在的檔案：${selected}`);
  }
}

export function normalizeCoursePlanCommandPlacement(plan, config = null) {
  if (!plan || !Array.isArray(plan.slides)) return plan;
  const slides = plan.slides.map((slide) => {
      let code = slide.code;
      if (['steps', 'code'].includes(slide.kind) && !String(code?.text || '').trim()) {
        const prose = [slide.title, slide.subtitle, ...(slide.bullets || []), slide.narration].filter(Boolean).join('\n');
        const commands = [];
        for (const pattern of promotableCommandPatterns) {
          for (const match of prose.matchAll(pattern)) {
            const command = match[0].trim();
            if (!commands.includes(command)) commands.push(command);
          }
        }
        if (commands.length > 0) {
          code = { language: 'powershell', text: commands.join('\n'), caption: '依來源文件在專案根目錄執行' };
        }
      }
      const codeLines = String(code?.text || '')
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length >= 3)
        .sort((left, right) => right.length - left.length);
      const replaceCodeEcho = (value) => {
        if (typeof value !== 'string') return value;
        let result = value;
        for (const line of codeLines) result = result.replaceAll(line, '畫面中的指令');
        return result;
      };
      const bullets = Array.isArray(slide.bullets)
        ? slide.bullets.filter((bullet) => !audienceReferencePattern.test(String(bullet))).map(neutralizeAudienceReferences)
        : slide.bullets;
      return {
        ...slide,
        code,
        title: neutralizeAudienceReferences(replaceCodeEcho(slide.title)),
        subtitle: neutralizeAudienceReferences(replaceCodeEcho(slide.subtitle)),
        bullets: Array.isArray(bullets) ? bullets.map(replaceCodeEcho) : bullets,
        narration: neutralizeAudienceReferences(replaceCodeEcho(slide.narration)),
      };
    });
  if (!slides.some((slide) => slide.kind === 'agenda')) {
    const topics = [];
    for (const slide of slides) {
      if (['cover', 'summary'].includes(slide.kind)) continue;
      const topic = String(slide.section || slide.title || '').trim();
      if (topic && !topics.includes(topic)) topics.push(topic);
      if (topics.length === 5) break;
    }
    while (topics.length < 2) topics.push(topics.length === 0 ? '環境與設定' : '建置與驗收');
    const evidence = slides.find((slide) => Array.isArray(slide.evidence) && slide.evidence.length > 0)?.evidence || [];
    const agenda = {
      kind: 'agenda',
      section: '課程導覽',
      title: '課程流程',
      subtitle: '依序完成設定、建置與驗收',
      bullets: topics,
      narration: `本課程依序包含${topics.join('、')}。每個階段都會對照來源內容、實際操作位置與成功判斷，最後完成投影片輸出，並準備後續影片製作所需的講稿與素材。`,
      evidence,
    };
    const maxSlides = Number(config?.project?.maxSlides) || Number.POSITIVE_INFINITY;
    if (slides.length < maxSlides) slides.splice(slides[0]?.kind === 'cover' ? 1 : 0, 0, agenda);
    else slides[slides[0]?.kind === 'cover' ? 1 : 0] = agenda;
  }
  return {
    ...plan,
    summary: truncateDisplayText(neutralizeAudienceReferences(plan.summary), 90),
    slides,
  };
}

export function validateCoursePlanShape(plan, config) {
  if (!plan || typeof plan !== 'object') throw new Error('course plan 必須是物件。');
  if (!String(plan.projectTitle || '').trim()) throw new Error('projectTitle 不得為空。');
  if (!String(plan.courseTitle || '').trim()) throw new Error('courseTitle 不得為空。');
  if ([...String(plan.projectTitle)].length > 80 || [...String(plan.courseTitle)].length > 120 || [...String(plan.summary || '')].length > 240) {
    throw new Error('projectTitle、courseTitle 或 summary 過長。');
  }
  for (const [field, value] of [['projectTitle', plan.projectTitle], ['courseTitle', plan.courseTitle], ['summary', plan.summary]]) {
    assertTraditionalProse(value, field);
  }
  if (!Array.isArray(plan.slides)) throw new Error('slides 必須是陣列。');
  if (plan.slides.length < config.project.minSlides || plan.slides.length > config.project.maxSlides) {
    throw new Error(`投影片頁數 ${plan.slides.length} 不在 ${config.project.minSlides}–${config.project.maxSlides} 範圍。`);
  }
  plan.slides.forEach((slide, index) => {
    if (!allowedKinds.has(slide.kind)) throw new Error(`第 ${index + 1} 頁 kind 不支援：${slide.kind}`);
    if (!String(slide.title || '').trim()) throw new Error(`第 ${index + 1} 頁 title 為空。`);
    if (typeof slide.title !== 'string' || [...slide.title].length > 80 || (slide.subtitle !== undefined && (typeof slide.subtitle !== 'string' || [...slide.subtitle].length > 120))) {
      throw new Error(`第 ${index + 1} 頁 title／subtitle 型別或長度不符。`);
    }
    if (!String(slide.narration || '').trim()) throw new Error(`第 ${index + 1} 頁 narration 為空。`);
    const narrationCharacters = [...String(slide.narration).replace(/\s/gu, '')].length;
    if (narrationCharacters < 40 || narrationCharacters > 260) throw new Error(`第 ${index + 1} 頁 narration ${narrationCharacters} 字，必須介於 40–260 字。`);
    if (!Array.isArray(slide.bullets)) throw new Error(`第 ${index + 1} 頁 bullets 必須是陣列。`);
    if (slide.bullets.length > 5) throw new Error(`第 ${index + 1} 頁超過五個重點。`);
    if (slide.bullets.some((bullet) => typeof bullet !== 'string' || !bullet.trim() || [...bullet].length > 100)) {
      throw new Error(`第 ${index + 1} 頁 bullets 必須是 1–100 字的非空字串。`);
    }
    const minimumBullets = ['agenda', 'steps', 'summary'].includes(slide.kind) ? 2 : (['concept', 'warning', 'code'].includes(slide.kind) ? 1 : 0);
    if (slide.bullets.length < minimumBullets) throw new Error(`第 ${index + 1} 頁 ${slide.kind} 至少需要 ${minimumBullets} 個重點。`);
    if (slide.kind === 'code' && !String(slide.code?.text || '').trim()) {
      throw new Error(`第 ${index + 1} 頁 code 必須把精確操作放在 code.text。`);
    }
    if (!Array.isArray(slide.evidence) || slide.evidence.length === 0 || slide.evidence.length > 10) throw new Error(`第 ${index + 1} 頁 evidence 必須介於 1–10 筆。`);
    for (const value of [slide.section, slide.title, slide.subtitle, ...(slide.bullets || []), slide.narration]) {
      assertTraditionalProse(value, `第 ${index + 1} 頁`);
    }
    if (slide.code && String(slide.code.text || '').split(/\r?\n/u).length > 12) {
      throw new Error(`第 ${index + 1} 頁程式碼超過十二行。`);
    }
    const combined = `${slide.title}\n${slide.subtitle || ''}\n${slide.narration}`;
    for (const phrase of forbiddenPhrases) {
      if (combined.includes(phrase)) throw new Error(`第 ${index + 1} 頁包含幕後禁詞：「${phrase}」。`);
    }
    const outsideCode = [slide.title, slide.subtitle || '', ...(slide.bullets || []), slide.narration].join('\n');
    if (unstructuredCommandPatterns.some((pattern) => pattern.test(outsideCode))) {
      throw new Error(`第 ${index + 1} 頁在 code 欄位外包含完整命令；請只保留目的與判斷，精確命令放入 code.text。`);
    }
    const allContent = `${outsideCode}\n${slide.code?.text || ''}`;
    if (dangerousCommandPatterns.some((pattern) => pattern.test(allContent))) {
      throw new Error(`第 ${index + 1} 頁包含高風險命令；MVP 不會將下載即執行、破壞性、提權或憑證讀取命令發布到成品。`);
    }
  });
  if (plan.slides[0]?.kind !== 'cover') throw new Error('第一頁必須是 cover。');
  if (!plan.slides.some((slide) => slide.kind === 'agenda')) throw new Error('課程必須包含 agenda 頁。');
  if (!plan.slides.some((slide) => ['steps', 'code'].includes(slide.kind))) throw new Error('課程必須包含至少一頁實際操作。');
  if (plan.slides.at(-1)?.kind !== 'summary') throw new Error('最後一頁必須是 summary。');
  if (config.tts.provider !== 'fixture') {
    const totalCharacters = plan.slides.reduce((sum, slide) => sum + [...String(slide.narration).replace(/\s/gu, '')].length, 0);
    const estimatedMinutes = totalCharacters / config.tts.estimatedCharactersPerMinute
      + plan.slides.length * (config.video.preRollMs + config.video.tailPaddingMs) / 60000;
    const ratio = estimatedMinutes / config.project.targetMinutes;
    if (ratio < 0.45 || ratio > 1.8) {
      throw new Error(`旁白預估 ${estimatedMinutes.toFixed(1)} 分鐘，與 targetMinutes=${config.project.targetMinutes} 差距過大；請調整旁白長度或目標片長。`);
    }
  }
}

export async function validateAndEnrichEvidence(plan, config, manifest) {
  const fileLookup = new Map(manifest.files.map((file) => [file.path, file]));
  const sourceCache = new Map();
  const evidenceItems = [];
  const slides = [];
  let evidenceCounter = 1;

  for (let index = 0; index < plan.slides.length; index += 1) {
    const slide = plan.slides[index];
    const enriched = [];
    for (const item of slide.evidence) {
      const relativePath = normalizeSlashes(item.path);
      const meta = fileLookup.get(relativePath);
      if (!meta) throw new Error(`第 ${index + 1} 頁引用不存在或未納入掃描的檔案：${relativePath}`);
      const startLine = Number(item.startLine);
      const endLine = Number(item.endLine);
      if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > meta.lines) {
        throw new Error(`第 ${index + 1} 頁引用行號無效：${relativePath}:${item.startLine}-${item.endLine}（檔案共 ${meta.lines} 行）`);
      }
      if (!String(item.claim || '').trim()) throw new Error(`第 ${index + 1} 頁的 evidence claim 不得為空。`);
      if (!sourceCache.has(relativePath)) {
        const { buffer } = await readVerifiedRepoFile(config, meta);
        sourceCache.set(relativePath, buffer.toString('utf8').replace(/^\uFEFF/u, '').split(/\r?\n/u));
      }
      const lines = sourceCache.get(relativePath);
      const excerpt = lines.slice(startLine - 1, endLine).join('\n');
      const evidence = {
        id: `E${String(evidenceCounter).padStart(4, '0')}`,
        path: relativePath,
        startLine,
        endLine,
        claim: String(item.claim || '').trim(),
        excerpt,
        excerptSha256: sha256(excerpt),
        fileSha256: meta.sha256,
        commit: manifest.git.commit,
      };
      evidenceCounter += 1;
      evidenceItems.push(evidence);
      enriched.push({ id: evidence.id, path: relativePath, startLine, endLine, claim: evidence.claim });
    }
    if (slide.code?.text) {
      const code = String(slide.code.text).replace(/\r\n/gu, '\n').trim();
      const evidenceText = evidenceItems
        .filter((entry) => enriched.some((reference) => reference.id === entry.id))
        .map((entry) => entry.excerpt.replace(/\r\n/gu, '\n'));
      const shellLike = /^(?:bash|sh|shell|powershell|cmd|batch)$/iu.test(String(slide.code.language || ''));
      const codeIsGrounded = shellLike
        ? code.split('\n').map((line) => line.trim()).filter(Boolean).every((line) => evidenceText.some((excerpt) => excerpt.includes(line)))
        : evidenceText.some((excerpt) => excerpt.includes(code));
      if (!codeIsGrounded) {
        throw new Error(`第 ${index + 1} 頁的 code／命令不是證據範圍中的逐字內容。`);
      }
    }
    slides.push({ ...slide, id: `S${String(index + 1).padStart(3, '0')}`, evidence: enriched });
  }

  const enrichedPlan = {
    schemaVersion: 1,
    projectTitle: String(plan.projectTitle).trim(),
    courseTitle: String(plan.courseTitle).trim(),
    summary: String(plan.summary || '').trim(),
    repo: {
      path: config.repoPath,
      commit: manifest.git.commit,
      dirty: manifest.git.dirty,
      dirtyCheck: manifest.git.dirtyCheck,
    },
    slides,
  };
  return {
    plan: enrichedPlan,
    evidenceManifest: {
      schemaVersion: 1,
      repo: enrichedPlan.repo,
      evidence: evidenceItems,
      coverage: {
        type: 'slide-reference-coverage',
        slides: slides.length,
        slidesWithEvidence: slides.filter((slide) => slide.evidence.length > 0).length,
        percent: 100,
        claimSemanticVerification: 'manual-required',
      },
      manualClaimReviewRequired: true,
    },
  };
}

export async function savePlanArtifacts(config, enriched) {
  await writeJsonAtomic(config.paths.coursePlan, enriched.plan);
  await writeJsonAtomic(config.paths.evidenceManifest, enriched.evidenceManifest);
}
