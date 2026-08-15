import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { synthesizeNarration } from '../src/lib/tts.mjs';
import { findCommand } from '../src/lib/utils.mjs';

test('只改一頁旁白時，只重做該頁音訊', async (t) => {
  if (!await findCommand('ffmpeg')) return t.skip('ffmpeg unavailable');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codereel-tts-'));
  const config = {
    cacheRoot: path.join(root, 'cache'),
    paths: {
      audio: path.join(root, 'audio'),
      ssml: path.join(root, 'audio', 'ssml'),
      intermediate: path.join(root, 'intermediate'),
      egressReport: path.join(root, 'intermediate', 'egress.json'),
    },
    llm: { timeoutMs: 30000 },
    tts: { provider: 'fixture', voice: 'fixture', rate: '0%', pronunciation: {} },
  };
  const first = [
    { slide: 1, title: '一', spoken: '第一頁', spokenCharacters: 3 },
    { slide: 2, title: '二', spoken: '第二頁', spokenCharacters: 3 },
  ];
  const initial = await synthesizeNarration(config, first);
  assert.equal(initial.synthesized, 2);
  const second = structuredClone(first);
  second[1].spoken = '第二頁已修改';
  second[1].spokenCharacters = 6;
  const rerun = await synthesizeNarration(config, second);
  assert.equal(rerun.cacheHits, 1);
  assert.equal(rerun.synthesized, 1);
});
