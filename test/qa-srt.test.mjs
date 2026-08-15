import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSrt } from '../src/lib/qa.mjs';

test('parseSrt 接受連續且完整的字幕', () => {
  const result = parseSrt('1\n00:00:00,600 --> 00:00:01,500\n第一段\n\n2\n00:00:01,500 --> 00:00:02,500\n第二段\n');
  assert.equal(result.cues.length, 2);
  assert.deepEqual(result.malformed, []);
});

test('parseSrt 不會略過格式錯誤的區塊', () => {
  const result = parseSrt('1\n00:00:00,600 --> 00:00:01,500\n第一段\n\n3\n錯誤時間\n第二段\n');
  assert.equal(result.cues.length, 1);
  assert.equal(result.malformed.length, 1);
});
