#!/usr/bin/env node
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { initializeConfig, loadConfig, resolveConfigPath, setActiveConfig } from './lib/config.mjs';
import { runDoctor } from './lib/doctor.mjs';
import { claudeModelCandidates } from './lib/llm.mjs';
import { readPipelineStatus, runPipeline, withPipelineLock } from './lib/pipeline.mjs';
import { parseCliArgs, readJson, writeJsonAtomic } from './lib/utils.mjs';
import { runQa } from './lib/qa.mjs';

const args = parseCliArgs(process.argv.slice(2));
const command = args._[0] || 'help';
const root = fileURLToPath(new URL('../', import.meta.url));

function interactive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY) && !args['no-prompt'];
}

async function ask(question, fallback = '') {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim() || fallback;
  } finally {
    rl.close();
  }
}

async function patchConfigFile(configPath, patch) {
  const stored = await readJson(configPath);
  await writeJsonAtomic(configPath, patch(stored));
}

async function applyModel(configPath, model, previous, resolved = '') {
  if (model === previous) return model;
  await patchConfigFile(configPath, (stored) => ({ ...stored, llm: { ...stored.llm, model } }));
  console.log(`已設定 llm.model = ${model}${resolved ? `（${resolved}）` : ''}`);
  return model;
}

async function chooseModel(config, configPath) {
  if (args.model && args.model !== true) {
    return await applyModel(configPath, String(args.model).trim(), config.llm.model);
  }
  if (!interactive()) return null;
  const candidates = claudeModelCandidates(config);
  console.log('\n分析與課程規劃要用哪個模型？');
  candidates.forEach((value, index) => {
    console.log(`  ${index + 1}) ${value}${value === config.llm.model ? '（目前）' : ''}`);
  });
  const answer = await ask(`\n輸入編號（直接按 Enter 沿用 ${config.llm.model}）：`);
  const picked = candidates[Number(answer) - 1];
  if (!picked) return null;
  return await applyModel(configPath, picked, config.llm.model);
}

async function resolvePurpose(config) {
  if (args.purpose && args.purpose !== true) {
    const purpose = String(args.purpose).trim();
    if (purpose) return purpose;
  }
  if (!interactive()) return config.project.purpose;
  console.log('\n這份教材要教什麼？方向會決定選哪些檔案與每一頁的內容。');
  console.log(`目前設定：${config.project.purpose}`);
  const purpose = await ask('輸入新的課程目的（直接按 Enter 沿用）：', config.project.purpose);
  if (purpose !== config.project.purpose) {
    await patchConfigFile(config.configPath, (stored) => ({ ...stored, project: { ...stored.project, purpose } }));
    console.log('已更新設定檔的 project.purpose。');
  }
  return purpose;
}

function help() {
  console.log(`CodeReel 0.1.0

用法：
  codereel init --repo <repo路徑> [--config codereel.config.json] [--model <模型名稱>]
  codereel doctor [--config <設定檔>]
  codereel analyze [--config <設定檔>] [--purpose "<課程目的>"] [--force]
  codereel build [--config <設定檔>] [--purpose "<課程目的>"] [--force] [--overwrite-deck-edits]
  codereel run [--config <設定檔>] [--purpose "<課程目的>"] [--approve-tts=<egress digest>] [--force] [--overwrite-deck-edits]
  codereel qa [--config <設定檔>]
  codereel status [--config <設定檔>]

階段：
  analyze  掃描 repo、建立證據與課程計畫
  build    再建立 PPTX、speaker notes 與 1920×1080 投影片
  run      再建立逐頁音訊、SRT、章節與 MP4

省略 --config 時，使用最近一次 init 選定的設定檔。
init 會列出模型讓你挑；analyze／build／run 會先確認課程目的。
加上 --no-prompt 可跳過所有互動詢問，直接沿用設定檔的值。
Azure 正式配音只有在未命中快取且傳入與外送預覽完全相符的 --approve-tts digest 時才會呼叫。`);
}

async function main() {
  if (command === 'help' || args.help) return help();
  if (command === 'init') {
    const hasExplicitConfig = Boolean(args.config && args.config !== true);
    const destination = hasExplicitConfig ? path.resolve(String(args.config)) : undefined;
    const sourceTemplate = path.join(root, 'codereel.config.example.json');
    const result = await initializeConfig({ sourceTemplate, destination, repoPath: args.repo, autoName: !hasExplicitConfig });
    const created = await loadConfig(result.path);
    await setActiveConfig(result.path);
    console.log(`${result.created ? '已建立' : '已沿用'}設定檔：${result.path}`);
    console.log('已設為目前專案。');
    if (created.llm.provider === 'claude-cli') await chooseModel(created, result.path);
    return;
  }
  const configPath = await resolveConfigPath(args.config);
  const config = await loadConfig(configPath);
  if (['analyze', 'build', 'run'].includes(command)) {
    console.log(`目前專案：${config.repoPath}`);
    console.log(`設定檔：${config.configPath}`);
  }
  if (command === 'doctor') {
    const report = await runDoctor(config);
    console.log(JSON.stringify(report, null, 2));
    if (!report.canBuildDeck) {
      if (report.llm?.available === false && report.llm.nextSteps?.length) {
        const label = report.llm.provider === 'claude-cli' ? 'Claude Code CLI 尚未就緒' : '本機 LLM 尚未就緒';
        console.error(`\n${label}：\n${report.llm.nextSteps.map((step) => `- ${step}`).join('\n')}`);
      }
      process.exitCode = 2;
    }
    return;
  }
  if (command === 'status') {
    console.log(JSON.stringify(await readPipelineStatus(config), null, 2));
    return;
  }
  if (command === 'qa') {
    console.log(JSON.stringify(await withPipelineLock(config, 'qa', async () => await runQa(config)), null, 2));
    return;
  }
  if (!['analyze', 'build', 'run'].includes(command)) {
    help();
    throw new Error(`未知命令：${command}`);
  }
  config.project.purpose = await resolvePurpose(config);
  const result = await runPipeline(config, {
    target: command,
    force: Boolean(args.force),
    approvedEgressDigest: String(args['approve-tts'] || ''),
    overwriteDeckEdits: Boolean(args['overwrite-deck-edits']),
  });
  console.log(JSON.stringify({
    completed: command,
    outputRoot: config.runRoot,
    deck: command === 'analyze' ? null : config.paths.deckFile,
    video: command === 'run' ? config.paths.finalVideo : null,
    qa: command === 'run' ? config.paths.qaReport : null,
    slides: result.plan.slides.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(`\nCodeReel 失敗：${error.message}`);
  if (process.env.CODEREEL_DEBUG === '1') console.error(error.stack);
  process.exitCode = error.code === 'PAID_APPROVAL_REQUIRED' ? 3 : 1;
});
