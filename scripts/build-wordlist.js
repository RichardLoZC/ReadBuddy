// ReadBuddy · 词汇分级数据构建
// 从 ECDICT（skywind3000/ECDICT，MIT 协议，77万词条）提炼三个精简 JSON：
//   data/wordbands.json  {word: band}      考纲带位：1中考 2高考 3四级 4六级 5考研 6雅思 7托福 8GRE
//   data/exchange.json   {form: lemma}     词形变换反查（时态/复数/比较级 → 原形）
//   data/freq.json       {word: frq}       当代语料词频排名（大纲外词的兜底判级）
// 用法：node scripts/build-wordlist.js [stardict.csv 路径]
//   CSV 缺失时提示下载：https://raw.githubusercontent.com/skywind3000/ECDICT/master/stardict.7z
'use strict';
const fs = require('fs');
const path = require('path');

const csvPath = process.argv[2] || path.join(__dirname, '..', 'data', 'stardict.csv');
if (!fs.existsSync(csvPath)) {
  console.error(`未找到 ${csvPath}`);
  console.error('请下载 ECDICT 完整数据并解压：');
  console.error('  curl -L -o /tmp/stardict.7z https://raw.githubusercontent.com/skywind3000/ECDICT/master/stardict.7z');
  console.error('  7zz x -y /tmp/stardict.7z stardict.csv -o/tmp');
  console.error('然后: node scripts/build-wordlist.js /tmp/stardict.csv');
  process.exit(1);
}

// 考纲标签 → 带位（数字越小越基础）。取词的多个标签中最小带位 = 学习者最早接触它的档位。
const TAG_BAND = { zk: 1, gk: 2, cet4: 3, cet6: 4, ky: 5, ielts: 6, toefl: 7, gre: 8 };
const FRQ_MAX = 100000; // 词频兜底表收词上限（排名更差的词查不到即视为生词候选）

const bands = Object.create(null);   // word -> band
const exchange = Object.create(null); // form -> lemma
const freq = Object.create(null);    // word -> frq rank
const exMeta = Object.create(null);  // form -> {band, frq} 冲突消解用
const unknownTags = new Map();

const isPlain = (s) => /^[a-z]+$/.test(s);

// 流式 CSV 解析（字段含引号包裹的逗号/换行，不能用逐行 split）
function parseCsv(file, onRow) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    let buf = '';
    let row = [];
    let cell = '';
    let inQuote = false;
    const pushCell = () => { row.push(cell); cell = ''; };
    const pushRow = () => { pushCell(); if (row.length > 1 || row[0]) onRow(row); row = []; };
    stream.on('data', (chunk) => {
      buf += chunk;
      let i = 0;
      while (i < buf.length) {
        const c = buf[i];
        if (inQuote) {
          if (c === '"') {
            if (buf[i + 1] === '"') { cell += '"'; i += 2; continue; }
            inQuote = false; i++; continue;
          }
          cell += c; i++; continue;
        }
        if (c === '"') { inQuote = true; i++; continue; }
        if (c === ',') { pushCell(); i++; continue; }
        if (c === '\n') { pushRow(); i++; continue; }
        if (c === '\r') { i++; continue; }
        cell += c; i++;
      }
      buf = '';
    });
    stream.on('end', () => { if (cell || row.length) pushRow(); resolve(); });
    stream.on('error', reject);
  });
}

function bandOfTags(tagField) {
  let best = null;
  for (const t of String(tagField || '').split(/\s+/)) {
    if (!t) continue;
    const b = TAG_BAND[t];
    if (b !== undefined) { if (best === null || b < best) best = b; }
    else if (/^[a-z0-9]+$/.test(t)) unknownTags.set(t, (unknownTags.get(t) || 0) + 1);
  }
  return best;
}

let n = 0;
parseCsv(csvPath, (row) => {
  if (row[0] === 'word') return; // 表头
  n++;
  const word = String(row[0] || '').toLowerCase();
  if (!word || !isPlain(word)) return;
  const band = bandOfTags(row[7]);
  // 词频：frq 优先，缺失时退回 bnc（ECDICT 的 frq 表漏了 an 等功能词，bnc 里有）
  const frq = parseInt(row[9], 10) || parseInt(row[8], 10) || 0;

  // 1) 考纲带位：同一词多条记录取最小带位
  if (band !== null && (bands[word] === undefined || band < bands[word])) bands[word] = band;

  // 2) 词频表
  if (frq > 0 && frq <= FRQ_MAX && (freq[word] === undefined || frq < freq[word])) freq[word] = frq;

  // 3) 词形变换反查表：只从「有考纲标签或词频较优」的词条构建（控制体积）
  if (band !== null || (frq > 0 && frq <= FRQ_MAX)) {
    const target = { band: band !== null ? band : 99, frq: frq || 999999 };
    for (const part of String(row[10] || '').split('/')) {
      const idx = part.indexOf(':');
      if (idx <= 0) continue;
      const code = part.slice(0, idx);
      let form = null;
      if (['p', 'd', 'i', '3', 'r', 't', 's'].includes(code)) form = part.slice(idx + 1); // 该词的某个屈折形式
      else if (code === '0') form = word; // 0:<lemma> 表示本词是 lemma 的变形
      if (!form || form === word) continue;
      form = form.toLowerCase();
      if (!isPlain(form) || form.length < 2 || form.length > 24) continue;
      const prev = exMeta[form];
      if (prev && (prev.band < target.band || (prev.band === target.band && prev.frq <= target.frq))) continue;
      exMeta[form] = target;
      exchange[form] = word;
    }
  }
}).then(() => {
  // 功能词保险：ECDICT 个别虚词既无标签也无频次（如 an），直接标为中考带位
  const FUNC_WORDS = ('a an the i you he she it we they me him her us them my your his its our their this that these those ' +
    'am is are was were be been being do does did done have has had will would can could shall should may might must ' +
    'not and or but if so as at by for from in into of on to with without up down out over under again then once there here when where why how all any both each few more most other some such only own same too very just don should now').split(' ');
  for (const w of FUNC_WORDS) {
    if (bands[w] === undefined) bands[w] = 1;
    if (freq[w] === undefined) freq[w] = 50;
  }

  // 变形行带位合并：measures 这类交叉引用行自带孤立高标签（如 toefl），
  // 应与其原形 measure 的带位取 min，保持词族一致
  for (let pass = 0; pass < 2; pass++) {
    for (const [form, lemma] of Object.entries(exchange)) {
      if (bands[lemma] !== undefined && (bands[form] === undefined || bands[lemma] < bands[form])) {
        bands[form] = bands[lemma];
      }
    }
  }

  // 词族一致性合并：opposition 在 ECDICT 只有 toefl 标签，但其词根 opposite 是高考词——
  // 派生词与词根共享 ≥4 字符前缀（排除 notion/note 这类不透明派生）且词根带位更低时取 min
  const FAMILY_SUFFIXES = ['ation', 'ition', 'tion', 'sion', 'ion', 'ally', 'ness', 'ment', 'ful', 'less', 'ish', 'able', 'ible', 'ive', 'ism', 'ist', 'ly'];
  const commonPrefix = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
  for (const [w, b] of Object.entries(bands)) {
    for (const suf of FAMILY_SUFFIXES) {
      if (!w.endsWith(suf) || w.length - suf.length < 3) continue;
      const base = w.slice(0, -suf.length);
      for (const root of [base, base + 'e', base.replace(/i$/, 'y')]) {
        if (root !== w && bands[root] !== undefined && bands[root] < b && commonPrefix(w, root) >= 4) {
          bands[w] = bands[root];
        }
      }
    }
  }

  const out = (name, obj) => fs.writeFileSync(path.join(__dirname, '..', 'data', name), JSON.stringify(obj));
  out('wordbands.json', bands);
  out('exchange.json', exchange);
  out('freq.json', freq);
  console.log(`词条总数 ${n.toLocaleString()}`);
  console.log(`wordbands.json  ${Object.keys(bands).length.toLocaleString()} 词（有考纲标签）`);
  console.log(`exchange.json   ${Object.keys(exchange).length.toLocaleString()} 条（词形→原形）`);
  console.log(`freq.json       ${Object.keys(freq).length.toLocaleString()} 词（词频 ≤ ${FRQ_MAX}）`);
  if (unknownTags.size) {
    const top = [...unknownTags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log('忽略的未知标签(前10):', top.map(([t, c]) => `${t}×${c}`).join(' '));
  }
  // 抽查
  for (const w of ['modest', 'carefully', 'perceives', 'negotiations', 'sanguine', 'government']) {
    console.log(`  抽查 ${w}: band=${bands[w] ?? '-'} ex=${exchange[w] ?? '-'} frq=${freq[w] ?? '-'}`);
  }
});
