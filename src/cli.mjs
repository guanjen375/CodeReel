#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeConfig, loadConfig } from './lib/config.mjs';
import { runDoctor } from './lib/doctor.mjs';
import { readPipelineStatus, runPipeline, withPipelineLock } from './lib/pipeline.mjs';
import { parseCliArgs } from './lib/utils.mjs';
import { runQa } from './lib/qa.mjs';

const args = parseCliArgs(process.argv.slice(2));
const command = args._[0] || 'help';
const root = fileURLToPath(new URL('../', import.meta.url));

function help() {
  console.log(`CodeReel 0.1.0

用法：
  codereel init --repo <repo路徑> [--config codereel.config.json]
  codereel doctor --config <設定檔>
  codereel analyze --config <設定檔> [--force]
  codereel build --config <設定檔> [--force] [--overwrite-deck-edits]
  codereel run --config <設定檔> [--approve-tts=<egress digest>] [--force] [--overwrite-deck-edits]
  codereel qa --config <設定檔>
  codereel status --config <設定檔>

階段：
  analyze  掃描 repo、建立證據與課程計畫
  build    再建立 PPTX、speaker notes 與 1920×1080 投影片
  run      再建立逐頁音訊、SRT、章節與 MP4

Azure 正式配音只有在未命中快取且傳入與外送預覽完全相符的 --approve-tts digest 時才會呼叫。`);
}

async function main() {
  if (command === 'help' || args.help) return help();
  if (command === 'init') {
    const destination = path.resolve(String(args.config || 'codereel.config.json'));
    const sourceTemplate = path.join(root, 'codereel.config.example.json');
    const target = await initializeConfig({ sourceTemplate, destination, repoPath: args.repo });
    console.log(`已建立設定檔：${target}`);
    return;
  }
  const configPath = String(args.config || 'codereel.config.json');
  const config = await loadConfig(configPath);
  if (command === 'doctor') {
    const report = await runDoctor(config);
    console.log(JSON.stringify(report, null, 2));
    if (!report.canBuildDeck) process.exitCode = 2;
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
