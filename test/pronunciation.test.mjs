import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSsml, buildSsmlBody, makeSpokenText, phonemeRules } from '../src/lib/narration.mjs';

const chong = {
  phonemeAlphabet: 'sapi',
  replacements: [
    { from: '重排', phoneme: 'chong2 pai2' },
    { from: '重跑', phoneme: 'chong2 pao3' },
    { from: 'CodeReel', to: 'Code Reel' },
  ],
};

test('只包住指定的多音字，其餘同字不受影響', () => {
  const body = buildSsmlBody('先重排向量，重點是不要重跑設定，權重會保留。', chong);
  assert.ok(body.includes('<phoneme alphabet="sapi" ph="chong2 pai2">重排</phoneme>'));
  assert.ok(body.includes('<phoneme alphabet="sapi" ph="chong2 pao3">重跑</phoneme>'));
  assert.ok(body.includes('重點是不要'), '重點必須維持原樣');
  assert.ok(body.includes('權重會保留'), '權重必須維持原樣');
  assert.equal(body.match(/<phoneme/gu).length, 2);
});

test('沒有 phoneme 規則時輸出與純轉義完全相同', () => {
  assert.equal(buildSsmlBody('a < b & c', {}), 'a &lt; b &amp; c');
  assert.equal(buildSsmlBody('重排向量', { replacements: [{ from: 'x', to: 'y' }] }), '重排向量');
});

test('周圍文字與 ph 屬性都會轉義，repo 內容無法變成標記', () => {
  const body = buildSsmlBody('<script>重排</script>', {
    replacements: [{ from: '重排', phoneme: 'chong2 pai2" onx="' }],
  });
  assert.ok(!body.includes('<script>'));
  assert.ok(body.includes('&lt;script&gt;'));
  assert.ok(body.includes('ph="chong2 pai2&quot; onx=&quot;"'));
  assert.equal(body.match(/<phoneme/gu).length, 1);
});

test('較長的詞優先比對，不會被短規則切斷', () => {
  const body = buildSsmlBody('重新載入', {
    replacements: [
      { from: '重', phoneme: 'chong2' },
      { from: '重新載入', phoneme: 'chong2 xin1 zai4 ru4' },
    ],
  });
  assert.ok(body.includes('ph="chong2 xin1 zai4 ru4">重新載入</phoneme>'));
  assert.equal(body.match(/<phoneme/gu).length, 1);
});

test('phoneme 規則不會改動計費文字，只在 SSML 生效', () => {
  const { spoken, audit } = makeSpokenText('先重排向量，再跑 CodeReel。', chong);
  assert.equal(spoken, '先重排向量，再跑 Code Reel。');
  assert.ok(audit.some((item) => item.rule === '重排' && item.phoneme === 'chong2 pai2' && item.matches === 1));
  assert.ok(audit.some((item) => item.rule === 'CodeReel' && item.replacement === 'Code Reel'));
});

test('phonemeAlphabet 可換掉，不必改程式', () => {
  const body = buildSsmlBody('重排', { phonemeAlphabet: 'ipa', replacements: [{ from: '重排', phoneme: 'ʈʂʰʊŋ pʰai' }] });
  assert.ok(body.includes('alphabet="ipa"'));
});

test('SSML 外層結構不變，phoneme 包在 prosody 內', () => {
  const ssml = buildSsml('重排', { tts: { voice: 'zh-TW-HsiaoChenNeural', rate: '-6%', pronunciation: chong } });
  assert.ok(ssml.startsWith('<speak version="1.0"'));
  assert.ok(ssml.includes('<voice name="zh-TW-HsiaoChenNeural">'));
  assert.ok(/<prosody rate="-6%"><phoneme [^>]*>重排<\/phoneme><\/prosody>/u.test(ssml), ssml);
});

test('phonemeRules 只收有 from 與 phoneme 的項目', () => {
  assert.deepEqual(
    phonemeRules({ replacements: [{ from: 'a', to: 'b' }, { from: '', phoneme: 'x' }, { phoneme: 'y' }, { from: '重排', phoneme: 'chong2 pai2' }] }),
    [{ from: '重排', phoneme: 'chong2 pai2' }],
  );
  assert.deepEqual(phonemeRules({}), []);
});
