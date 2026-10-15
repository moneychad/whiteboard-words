import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadCore() {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const match = html.match(/<script id="core">([\s\S]*?)<\/script>/);
  assert.ok(match, 'index.html 应包含 id="core" 的核心逻辑脚本');
  const context = vm.createContext({ console });
  vm.runInContext(match[1], context);
  assert.ok(context.WordBoardCore, '核心脚本应暴露 WordBoardCore');
  return context.WordBoardCore;
}

test('随机重排保持词语不变且尽量避免留在原位', () => {
  const core = loadCore();
  const original = ['太阳', '月亮', '星星', '云朵'];
  const shuffled = core.shuffleAvoidingFixedPoints(original, () => 0);
  assert.deepEqual(Array.from(shuffled), ['月亮', '星星', '云朵', '太阳']);
  assert.deepEqual(original, ['太阳', '月亮', '星星', '云朵']);
  assert.deepEqual(Array.from(core.shuffleAvoidingFixedPoints(['唯一'], () => 0)), ['唯一']);
});

test('根据学习历史计算掌握状态和记住又忘了', () => {
  const core = loadCore();
  const summarize = (results) => {
    const summary = core.summarizeWord(results.map((result) => ({ result })));
    return { status: summary.status, attempts: summary.attempts };
  };

  assert.deepEqual(summarize([]), { status: 'new', attempts: 0 });
  assert.deepEqual(summarize(['known']), { status: 'mastered', attempts: 1 });
  assert.deepEqual(summarize(['known', 'known']), { status: 'mastered', attempts: 2 });
  assert.deepEqual(summarize(['known', 'unknown']), { status: 'forgotten', attempts: 2 });
  assert.deepEqual(summarize(['unknown', 'fuzzy', 'unknown']), { status: 'learning', attempts: 3 });
  assert.equal(core.summarizeWord([{ result: 'fuzzy' }]).knownCount, 0);
});

test('根据本次结果安排下次复习日期', () => {
  const core = loadCore();
  const nextDate = (results) => core.getNextReviewDate(
    results.map((result) => ({ result })),
    '2026-10-15',
  );
  assert.equal(nextDate(['unknown']), '2026-10-15');
  assert.equal(nextDate(['fuzzy']), '2026-10-15');
  assert.equal(nextDate(['known']), '2026-10-17');
  assert.equal(nextDate(['known', 'known']), '2026-10-22');
  assert.equal(nextDate([]), null);
});

test('解析自定义词语并提示不符合二至三字要求的条目', () => {
  const core = loadCore();
  const parsed = core.parseCustomWords('太阳, 月亮；星星\n太阳 车');
  assert.deepEqual(Array.from(parsed.words), ['太阳', '月亮', '星星']);
  assert.deepEqual(Array.from(parsed.invalid), ['车']);
});

test('保存学习场次后累计每个词语的历史和复习日期', () => {
  const core = loadCore();
  const first = core.recordSession({}, {
    id: 's1',
    date: '2026-10-14',
    words: ['太阳', '月亮'],
    results: { 太阳: 'known', 月亮: 'unknown' },
  });
  assert.equal(first.太阳.attempts.length, 1);
  assert.equal(first.太阳.nextReview, '2026-10-16');
  assert.equal(first.月亮.nextReview, '2026-10-14');

  const second = core.recordSession(first, {
    id: 's2',
    date: '2026-10-15',
    words: ['太阳'],
    results: { 太阳: 'unknown' },
  });
  assert.equal(second.太阳.attempts.length, 2);
  assert.equal(core.summarizeWord(second.太阳.attempts).status, 'forgotten');
  assert.equal(second.太阳.nextReview, '2026-10-15');
  assert.equal(first.太阳.attempts.length, 1, '不应修改旧状态');

  const fuzzy = core.recordSession({}, {
    id: 's3',
    date: '2026-10-14',
    words: ['小草'],
    results: { 小草: 'fuzzy' },
  });
  assert.equal(fuzzy.小草.nextReview, '2026-10-14');
});

test('复习列表只选取到期词语并优先安排困难词', () => {
  const core = loadCore();
  const stats = {
    太阳: { word: '太阳', attempts: [{ result: 'known' }], nextReview: '2026-10-15' },
    月亮: { word: '月亮', attempts: [{ result: 'unknown' }], nextReview: '2026-10-14' },
    星星: { word: '星星', attempts: [{ result: 'unknown' }], nextReview: '2026-10-16' },
    云朵: { word: '云朵', attempts: [{ result: 'fuzzy' }], nextReview: '2026-10-15' },
  };
  const due = core.getDueWords(stats, '2026-10-15');
  assert.deepEqual(Array.from(due, (record) => record.word), ['月亮', '云朵', '太阳']);
});

test('每个难度和主题至少有十六个不重复的二至三字词语', () => {
  const core = loadCore();
  Object.entries(core.WORD_BANK).forEach(([level, topics]) => {
    Object.entries(topics).forEach(([topic, words]) => {
      assert.ok(words.length >= 16, `${level}/${topic} 词库不足`);
      assert.equal(new Set(words).size, words.length, `${level}/${topic} 存在重复词`);
      words.forEach((word) => assert.match(word, /^[\u3400-\u4dbf\u4e00-\u9fff]{2,3}$/u));
    });
  });
  const selected = core.selectWords(core.WORD_BANK[0].animals, 16, () => 0.42);
  assert.equal(selected.length, 16);
  assert.equal(new Set(selected).size, 16);
});

test('方阵选词时不同词语之间不共用汉字', () => {
  const core = loadCore();
  const selected = core.selectDistinctCharacterWords(
    ['小草', '小羊', '太阳', '月亮', '花朵', '白云'],
    4,
    () => 0.37,
  );
  assert.equal(selected.length, 4);
  const characters = selected.flatMap((word) => Array.from(new Set(word)));
  assert.equal(new Set(characters).size, characters.length);
  assert.ok(!(selected.includes('小草') && selected.includes('小羊')));
});

test('备份导入前校验学习结果和词语历史结构', () => {
  const core = loadCore();
  const validBackup = {
    version: 1,
    sessions: [{
      id: 's1', kind: 'chinese-word', mode: 'learn', createdAt: '2026-10-14T08:00:00.000Z',
      completedAt: '2026-10-14T08:10:00.000Z', date: '2026-10-14', level: '0', topic: 'mixed',
      requestedSize: 1, columns: 1, words: ['太阳'], results: { 太阳: 'known' },
      stage: 'completed', photo: null, ocrResults: [],
    }],
    wordStats: {
      太阳: { word: '太阳', attempts: [{ sessionId: 's1', date: '2026-10-14', result: 'known' }], nextReview: '2026-10-16' },
    },
    settings: { level: '0', topic: 'mixed', size: 4, reviewSize: 4 },
  };
  const sanitized = core.sanitizeBackup(validBackup);
  assert.equal(sanitized.currentSession, null);
  assert.equal(sanitized.sessions[0].results.太阳, 'known');

  const xssBackup = structuredClone(validBackup);
  xssBackup.sessions[0].results.太阳 = 'known"><img src=x onerror=alert(1)>';
  assert.throws(() => core.sanitizeBackup(xssBackup), /备份格式不正确/);

  const corruptStats = structuredClone(validBackup);
  corruptStats.wordStats.太阳 = { word: '太阳' };
  assert.throws(() => core.sanitizeBackup(corruptStats), /备份格式不正确/);
});

test('复习选词优先保留最到期词语，冲突时保留更多可用词', () => {
  const core = loadCore();
  const records = ['太阳', '月亮', '白云', '星星', '花朵'].map((word) => ({ word }));
  assert.deepEqual(
    Array.from(core.selectReviewWords(records, 4, () => 0), (record) => record.word).sort(),
    ['太阳', '白云', '星星', '月亮'].sort(),
  );
  const conflicting = ['小草', '小羊', '太阳'].map((word) => ({ word }));
  const selected = core.selectReviewWords(conflicting, 4, () => 0);
  assert.equal(selected.length, 2);
  const characters = selected.flatMap((record) => Array.from(new Set(record.word)));
  assert.equal(new Set(characters).size, characters.length);
});

test('区分当日复习和合并复习的候选词语', () => {
  const core = loadCore();
  const attempt = (date, result) => [{ sessionId: 'seed', date, result }];
  const wordStats = {
    太阳: { word: '太阳', attempts: attempt('2026-10-15', 'known'), nextReview: '2026-10-17' },
    月亮: { word: '月亮', attempts: attempt('2026-10-15', 'fuzzy'), nextReview: '2026-10-15' },
    白云: { word: '白云', attempts: attempt('2026-10-15', 'unknown'), nextReview: '2026-10-15' },
    星星: { word: '星星', attempts: attempt('2026-10-14', 'fuzzy'), nextReview: '2026-10-15' },
    花朵: { word: '花朵', attempts: attempt('2026-10-14', 'known').concat(attempt('2026-10-15', 'unknown')), nextReview: '2026-10-15' },
  };
  const sessions = [
    { date: '2026-10-15', words: ['太阳', '月亮', '白云', '花朵'], results: { 太阳: 'known', 月亮: 'fuzzy', 白云: 'unknown', 花朵: 'unknown' } },
  ];
  const today = core.getReviewCandidates(wordStats, sessions, '2026-10-15', 'today');
  assert.deepEqual(Array.from(today, (record) => record.word).sort(), ['月亮', '白云', '花朵'].sort());
  const merged = core.getReviewCandidates(wordStats, sessions, '2026-10-15', 'merged');
  assert.deepEqual(Array.from(merged, (record) => record.word).sort(), ['月亮', '白云', '星星', '花朵'].sort());
});