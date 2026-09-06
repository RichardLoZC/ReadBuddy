/* ReadBuddy · 前端逻辑
   分词与词频匹配 → LLM 标注 → ruby 行内直标渲染 → 点词查词 → 档案动态更新 */
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const LEVELS = [
  { id: 'zhongkao', label: '初中（中考）', threshold: 1600 },
  { id: 'gaokao', label: '高中（高考）', threshold: 3500 },
  { id: 'cet4', label: '大学四级', threshold: 5000 },
  { id: 'cet6', label: '大学六级', threshold: 6500 },
  { id: 'kaoyan', label: '考研', threshold: 7500 },
  { id: 'ielts', label: '雅思', threshold: 9000 },
  { id: 'toefl', label: '托福/进阶', threshold: 12000 },
];

const LS_HISTORY = 'erm_history';
const LS_LOOKUPS = 'erm_lookups';
const LS_THEME = 'erm_theme';

const state = {
  profile: null,
  freq: null,          // {word: rank}
  images: [],          // 待识别图片 dataURL 池
  article: null,       // 当前文章 {id,title,text,list,extras,mock,annotations:Map,createdAt}
  popoverWord: null,   // 当前查词卡片对应的 {word, lemma, node}
  quiz: null,
};

// ================= 档案 =================

async function loadProfile() {
  const res = await fetch('/api/profile');
  state.profile = await res.json();
}

let saveTimer = null;
function saveProfile() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await fetch('/api/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.profile),
    });
  }, 300);
}

// ================= 词汇分级（ECDICT 三层判级） =================
// ① 考纲标签带位（wordbands.json：1中考…7托福 8GRE）② 词形变换（exchange.json）→ 原形带位
// ③ 透明派生词族回溯（carefully→careful）④ 词频兜底（freq.json，仅大纲外词）
const BAND_MAX = { zhongkao: 1, gaokao: 2, cet4: 3, cet6: 4, kaoyan: 5, ielts: 6, toefl: 7 };

async function ensureWordData() {
  if (state.freq) return;
  const [freq, bands, ex] = await Promise.all([
    fetch('/data/freq.json').then((r) => r.json()),
    fetch('/data/wordbands.json').then((r) => r.json()),
    fetch('/data/exchange.json').then((r) => r.json()),
  ]);
  state.freq = freq;
  state.bands = bands;
  state.exchange = ex;
}

// 词形归一：小写、曲引号、所有格、缩约词、不规则变形
function normalize(raw) {
  let w = raw.toLowerCase().replace(/’/g, "'");
  w = w.replace(/'s$|'$/, ''); // government's → government；inventors' → inventors
  const resolve = (x) => IRREG[x] || x;
  w = resolve(w);
  const special = { "won't": 'will', "can't": 'can', cannot: 'can', "shan't": 'shall' };
  if (special[w]) return special[w];
  const contr = w.match(/^(.+?)n't$/) || w.match(/^(.+?)'(?:s|re|ve|ll|m|d)$/);
  if (contr) return resolve(contr[1]);
  return w;
}

// 透明派生候选（Bauer & Nation 词族思路）：carefully→careful，resoluteness→resolute
const DERIV_SUFFIXES = ['ation', 'ition', 'tion', 'sion', 'ion', 'ally', 'ness', 'ment', 'ful', 'less', 'ish', 'able', 'ible', 'ive', 'ism', 'ist', 'ly', 'er', 'or'];
const DERIV_PREFIXES = ['un', 'in', 'im', 'dis', 're', 'non', 'mis', 'pre', 'over', 'under'];
function derivCandidates(w) {
  const out = [];
  for (const suf of DERIV_SUFFIXES) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) {
      const base = w.slice(0, -suf.length);
      out.push(base, base + 'e');
      if (base.endsWith('i')) out.push(base.slice(0, -1) + 'y'); // happily→happy
    }
  }
  for (const pre of DERIV_PREFIXES) {
    if (w.startsWith(pre) && w.length - pre.length >= 4) out.push(w.slice(pre.length));
  }
  return out;
}

// 三层判级，返回 {lemma, band|null, rank|Infinity}；band 优先于 rank
function classify(raw) {
  const w = normalize(raw);
  if (!w || !/^[a-z]/.test(w)) return { lemma: (raw || '').toLowerCase(), band: null, rank: Infinity };
  const bandOf = (x) => (x && state.bands[x] !== undefined ? state.bands[x] : null);
  // ① 直接命中考纲标签
  if (bandOf(w) !== null) return { lemma: w, band: state.bands[w], rank: state.freq[w] ?? Infinity };
  // ② 词形变换反查（perceives→perceive，delegates→delegate）
  const ex = state.exchange[w];
  if (ex && bandOf(ex) !== null) return { lemma: ex, band: state.bands[ex], rank: state.freq[ex] ?? Infinity };
  // ③ 透明派生回溯，取带位最小的词根
  let family = null;
  for (const cand of derivCandidates(w)) {
    const root = bandOf(cand) !== null ? cand : (state.exchange[cand] && bandOf(state.exchange[cand]) !== null ? state.exchange[cand] : null);
    if (root && (family === null || state.bands[root] < family.band)) {
      family = { lemma: root, band: state.bands[root], rank: state.freq[root] ?? Infinity };
    }
  }
  if (family) return family;
  // ④ 词频兜底（大纲外词：sanguine 这类词只能靠词频）
  let best = null;
  for (const cand of new Set([w, ex, ...variants(w)].filter(Boolean))) {
    const r = state.freq[cand];
    if (r !== undefined && (best === null || r < best.rank)) best = { lemma: cand, band: null, rank: r };
  }
  return best || { lemma: ex || w, band: null, rank: Infinity };
}

// 生成词形变体候选（查表取排名最优者即视为该词的引理）
function variants(w) {
  const out = new Set([w]);
  const add = (s) => { if (s && s.length >= 2) out.add(s); };
  if (w.endsWith('ies') && w.length > 4) add(w.slice(0, -3) + 'y');
  if (/(?:ses|xes|zes|ches|shes)$/.test(w)) add(w.slice(0, -2));
  else if (w.endsWith('es') && w.length > 3) { add(w.slice(0, -2)); add(w.slice(0, -1)); }
  else if (w.endsWith('s') && !w.endsWith('ss') && w.length > 2) add(w.slice(0, -1));
  if (w.endsWith('ied') && w.length > 4) add(w.slice(0, -3) + 'y');
  if (w.endsWith('ed') && w.length > 3) {
    add(w.slice(0, -2));
    add(w.slice(0, -2) + 'e');
    add(w.slice(0, -1));
    if (w.length > 4 && /(.)\1ed$/.test(w)) add(w.slice(0, -3)); // stopped→stop
  }
  if (w.endsWith('ing') && w.length > 4) {
    add(w.slice(0, -3));
    add(w.slice(0, -3) + 'e');
    if (w.length > 5 && /(.)\1ing$/.test(w)) add(w.slice(0, -4)); // running→run
  }
  if (w.endsWith('er') && w.length > 4) {
    add(w.slice(0, -1));
    add(w.slice(0, -2));
    if (w.length > 4 && /(.)\1er$/.test(w)) add(w.slice(0, -3)); // bigger→big
  }
  if (w.endsWith('est') && w.length > 4) {
    add(w.slice(0, -2));
    add(w.slice(0, -3));
    if (w.length > 5 && /(.)\1est$/.test(w)) add(w.slice(0, -4)); // biggest→big
  }
  if (w.endsWith('ly') && w.length > 4) add(w.slice(0, -2));
  if (w.endsWith('ves') && w.length > 4) { add(w.slice(0, -3) + 'f'); add(w.slice(0, -3) + 'fe'); } // scarves→scarf, knives→knife
  return out;
}

// 常见不规则变形 → 原形（动词过去式/过去分词 + 不规则复数）
const IRREG = {
  went: 'go', gone: 'go', saw: 'see', seen: 'see', did: 'do', done: 'do',
  was: 'be', were: 'be', been: 'be', had: 'have', has: 'have', made: 'make', said: 'say',
  took: 'take', taken: 'take', came: 'come', got: 'get', gotten: 'get', gave: 'give', given: 'give',
  found: 'find', thought: 'think', told: 'tell', felt: 'feel', left: 'leave', kept: 'keep',
  held: 'hold', brought: 'bring', bought: 'buy', wrote: 'write', written: 'write', sat: 'sit',
  stood: 'stand', lost: 'lose', paid: 'pay', met: 'meet', understood: 'understand', ran: 'run',
  spent: 'spend', grew: 'grow', grown: 'grow', heard: 'hear', built: 'build', fell: 'fall',
  fallen: 'fall', began: 'begin', begun: 'begin', became: 'become', chose: 'choose', chosen: 'choose',
  drew: 'draw', drawn: 'draw', drove: 'drive', driven: 'drive', ate: 'eat', eaten: 'eat',
  broke: 'break', broken: 'break', spoke: 'speak', spoken: 'speak', flew: 'fly', flown: 'fly',
  forgot: 'forget', forgotten: 'forget', knew: 'know', known: 'know', threw: 'throw', thrown: 'throw',
  wore: 'wear', worn: 'wear', won: 'win', caught: 'catch', taught: 'teach', sold: 'sell', sent: 'send',
  lent: 'lend', slept: 'sleep', swept: 'sweep', fought: 'fight', sought: 'seek', led: 'lead',
  misled: 'mislead', hid: 'hide', hidden: 'hide', rose: 'rise', risen: 'rise', arose: 'arise',
  shook: 'shake', shaken: 'shake', sank: 'sink', sunk: 'sink', sprang: 'spring', sprung: 'spring',
  rang: 'ring', rung: 'ring', sang: 'sing', sung: 'sing', swam: 'swim', swum: 'swim',
  laid: 'lay', lain: 'lie', struck: 'strike', wound: 'wind', shrank: 'shrink', shrunk: 'shrink',
  froze: 'freeze', frozen: 'freeze', stole: 'steal', stolen: 'steal', swore: 'swear', sworn: 'swear',
  tore: 'tear', torn: 'tear', bore: 'bear', borne: 'bear', beat: 'beat', bound: 'bind',
  bled: 'bleed', bred: 'breed', blew: 'blow', blown: 'blow', bent: 'bend', bit: 'bite', bitten: 'bite',
  crept: 'creep', dug: 'dig', fed: 'feed', fled: 'flee', hung: 'hang', knelt: 'kneel', lit: 'light',
  rode: 'ride', ridden: 'ride', slid: 'slide', sped: 'speed', spun: 'spin', stuck: 'stick',
  stung: 'sting', stank: 'stink', stuck_out: '', trod: 'tread', woke: 'wake', woken: 'wake',
  wove: 'weave', woven: 'weave', withdrew: 'withdraw', withdrawn: 'withdraw', wrung: 'wring',
  children: 'child', men: 'man', women: 'woman', feet: 'foot', teeth: 'tooth', mice: 'mouse',
  geese: 'goose', oxen: 'ox', halves: 'half', knives: 'knife', wives: 'wife', lives: 'life',
  leaves: 'leaf', loaves: 'loaf', wolves: 'wolf', shelves: 'shelf', thieves: 'thief', calves: 'calf',
};

// 扫描全文，找出潜在生词（按出现顺序）
function findCandidates(text) {
  const { level, threshold, knownWords, unknownWords } = state.profile;
  const maxBand = BAND_MAX[level] ?? 3;
  const re = /[A-Za-z][A-Za-z'’-]*/g;
  const seen = new Set();
  const forced = [];
  const cands = [];
  let m;
  while ((m = re.exec(text))) {
    const token = m[0];
    // 连字符复合词（coal-fired）：各部分都认识则整词跳过
    if (token.includes('-')) {
      const parts = token.split('-').filter((p) => /[A-Za-z]/.test(p));
      if (parts.length > 1 && parts.every((p) => {
        const c = classify(p);
        return knownWords[c.lemma] || (c.band !== null ? c.band <= maxBand : (c.rank !== Infinity && c.rank <= threshold));
      })) {
        for (const p of parts) seen.add(classify(p).lemma);
        continue;
      }
    }
    const { lemma, band, rank } = classify(token);
    if (knownWords[lemma] || seen.has(lemma)) continue;
    seen.add(lemma);
    if (unknownWords[lemma]) { forced.push(token); continue; }
    // 带位高于读者档位才标；大纲外词退回词频阈值
    const flag = band !== null ? band > maxBand : (rank === Infinity || rank > threshold);
    if (flag) cands.push(token);
  }
  return [...forced, ...cands.slice(0, 150)];
}

// ================= 图片输入 =================

async function fileToDataUrl(file) {
  const bmp = await createImageBitmap(file);
  const max = 1600;
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.82);
}

async function addImages(files) {
  const imgs = [...files].filter((f) => f.type.startsWith('image/'));
  if (!imgs.length) return;
  for (const f of imgs.slice(0, 12)) state.images.push(await fileToDataUrl(f));
  renderThumbs();
  switchTab('photo');
}

function renderThumbs() {
  const box = $('#thumbs');
  box.innerHTML = '';
  state.images.forEach((url, i) => {
    const div = document.createElement('div');
    div.className = 'thumb';
    const img = document.createElement('img');
    img.src = url;
    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = i + 1;
    const rm = document.createElement('button');
    rm.className = 'rm';
    rm.textContent = '×';
    rm.title = '移除';
    rm.onclick = () => { state.images.splice(i, 1); renderThumbs(); };
    div.append(img, idx, rm);
    box.appendChild(div);
  });
  $('#btnTranscribe').disabled = !state.images.length;
}

async function doTranscribe() {
  if (!state.images.length) return;
  const btn = $('#btnTranscribe');
  const status = $('#transcribeStatus');
  btn.disabled = true;
  status.className = 'status';
  status.textContent = `正在识别 ${state.images.length} 张图片…（视觉模型：${state.profile.settings.visionProvider.model}）`;
  try {
    const res = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: state.images, provider: state.profile.settings.visionProvider }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    $('#articleInput').value = data.text;
    switchTab('paste');
    status.className = 'status ok';
    status.textContent = `识别完成（${data.text.length} 字符）——请花 10 秒校对下方文本，然后点「生成注释阅读」`;
  } catch (e) {
    status.className = 'status err';
    status.textContent = '识别失败：' + e.message;
  } finally {
    btn.disabled = !state.images.length;
  }
}

// ================= 标注与阅读 =================

function makeTitle(text) {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').slice(0, 9).join(' ');
  return words + (text.trim().split(/\s+/).length > 9 ? '…' : '');
}

async function doAnnotate() {
  const text = $('#articleInput').value.trim();
  if (!text) { toast('请先粘贴英文文章，或用「拍照识别」转录书页'); return; }
  await ensureWordData();

  const words = findCandidates(text);
  const btn = $('#btnAnnotate');
  const status = $('#annotateStatus');
  btn.disabled = true;
  status.className = 'status';
  status.textContent = `已找到 ${words.length} 个候选生词，正在让 LLM 标注…（文本模型：${state.profile.settings.textProvider.model}）`;

  try {
    const res = await fetch('/api/annotate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, words, provider: state.profile.settings.textProvider }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    const annotations = new Map();
    for (const item of data.list || []) {
      if (item?.word) annotations.set(String(item.word).toLowerCase(), item);
    }
    state.article = {
      id: Date.now(),
      createdAt: new Date().toISOString(),
      title: makeTitle(text),
      text,
      list: data.list || [],
      extras: data.extras || [],
      mock: !!data.mock,
      annotations,
    };
    saveHistory(state.article);

    state.profile.stats.reads = (state.profile.stats.reads || 0) + 1;
    saveProfile();

    status.textContent = '';
    showReader();
    renderStats();
  } catch (e) {
    status.className = 'status err';
    status.textContent = '标注失败：' + e.message;
  } finally {
    btn.disabled = false;
  }
}

function showReader() {
  $('#inputCard').classList.add('hidden');
  $('#readerCard').classList.remove('hidden');
  $('#mockBanner').classList.toggle('hidden', !state.article?.mock);
  const n = state.article?.list?.length || 0;
  $('#readerMeta').textContent = `${state.article?.title || ''} · 标注 ${n} 词`;
  renderExtras();
  renderArticle();
}

function backToInput() {
  $('#readerCard').classList.add('hidden');
  $('#inputCard').classList.remove('hidden');
}

function renderExtras() {
  const box = $('#extraWords');
  box.innerHTML = '';
  for (const item of state.article?.extras || []) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = item.word;
    chip.title = `${item.common || ''}｜文中：${item.context || ''}`;
    box.appendChild(chip);
  }
}

function renderArticle() {
  const container = $('#articleRender');
  container.innerHTML = '';
  if (!state.article) return;

  const density = state.profile.settings.density || 'first';
  const seen = new Set();
  const paras = state.article.text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  for (const para of paras) {
    const p = document.createElement('p');
    const normalized = para.replace(/\s*\n\s*/g, ' ');
    const re = /[A-Za-z][A-Za-z'’-]*/g;
    let last = 0, m;
    while ((m = re.exec(normalized))) {
      if (m.index > last) p.appendChild(document.createTextNode(normalized.slice(last, m.index)));
      last = m.index + m[0].length;
      p.appendChild(makeWordNode(m[0], density, seen));
    }
    if (last < normalized.length) p.appendChild(document.createTextNode(normalized.slice(last)));
    container.appendChild(p);
  }
}

function makeWordNode(surface, density, seen) {
  const low = surface.toLowerCase();
  const best = classify(surface);
  const anno = state.article.annotations.get(low) || state.article.annotations.get(best.lemma);
  const known = state.profile.knownWords[best.lemma];

  let node;
  if (anno && !known) {
    if (!seen.has(best.lemma) || density === 'all') {
      node = document.createElement('ruby');
      node.className = 'anno';
      const w = document.createElement('span');
      w.textContent = surface;
      const rt = document.createElement('rt');
      rt.textContent = anno.context || anno.common || '';
      node.append(w, rt);
      seen.add(best.lemma);
    } else {
      node = document.createElement('span');
      node.className = 'w dotted';
      node.textContent = surface;
    }
  } else {
    node = document.createElement('span');
    node.className = 'w';
    node.textContent = surface;
  }
  node.dataset.word = surface;
  node.dataset.lemma = best.lemma;
  return node;
}

// ================= 导出 PDF =================

// 打印版文档：衬线正文 + 词下中文小注（ruby under），A4 自带页边距。
// Electron 里走主进程 printToPDF（Chromium 渲染，中英混排保真）；
// 普通浏览器里打开新窗口调 print()，由系统对话框另存为 PDF。
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function buildPrintHtml() {
  const art = $('#articleRender').cloneNode(true);
  art.querySelectorAll('.dotted').forEach((el) => el.classList.remove('dotted'));
  const a = state.article;
  const n = a.list?.length || a.annotations?.size || 0;
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>${escHtml(a.title || 'ReadBuddy')}</title>
<style>
  @page { size: A4; margin: 0; }
  body { font-family: "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", Georgia, "Times New Roman", serif;
         font-size: 11.5pt; line-height: 2; color: #26211a; margin: 0; padding: 16mm 15mm 18mm; }
  h1 { font-size: 15pt; line-height: 1.55; margin: 0 0 4pt; }
  .meta { font-size: 9pt; color: #8a8172; margin: 0 0 13pt; padding-bottom: 7pt; border-bottom: 0.6pt solid #d8d2c4; }
  p { margin: 0 0 7pt; text-align: justify; orphans: 2; widows: 2; }
  ruby.anno { ruby-position: under; }
  ruby.anno rt { font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
                 font-size: 8pt; line-height: 1.3; color: #0f766e; letter-spacing: 0; }
</style>
</head>
<body>
<h1>${escHtml(a.title || 'ReadBuddy')}</h1>
<p class="meta">ReadBuddy 导出 · 生词标注 ${n} 个 · ${new Date().toLocaleDateString('zh-CN')}</p>
${art.innerHTML}
</body>
</html>`;
}

async function exportPdf() {
  if (!state.article || !$('#articleRender').children.length) { toast('当前没有打开的文章'); return; }
  const html = buildPrintHtml();
  if (window.erm?.isElectron) {
    toast('正在生成 PDF…');
    const name = `${(state.article.title || 'ReadBuddy').replace(/[\\/:*?"<>|]/g, '').slice(0, 40)}.pdf`;
    const r = await window.erm.exportPdf(html, name);
    toast(r.ok ? `已导出：${r.path}` : (r.canceled ? '已取消导出' : `导出失败：${r.error || '未知错误'}`));
  } else {
    const w = window.open('', '_blank');
    if (!w) { toast('导出窗口被浏览器拦截，请允许本站弹窗后重试'); return; }
    w.document.open();
    w.document.write(html);
    w.document.close();
    w.addEventListener('load', () => setTimeout(() => w.print(), 400));
  }
}

// ================= 点词查词 =================

function lookupCache() {
  try { return JSON.parse(localStorage.getItem(LS_LOOKUPS) || '{}'); } catch { return {}; }
}

function cacheLookup(word, data) {
  const cache = lookupCache();
  cache[word] = { ...data, ts: Date.now() };
  const keys = Object.keys(cache);
  if (keys.length > 600) for (const k of keys.slice(0, keys.length - 600)) delete cache[k];
  localStorage.setItem(LS_LOOKUPS, JSON.stringify(cache));
}

function sentenceOf(node) {
  const p = node.closest('p');
  if (!p) return '';
  const text = p.textContent;
  const word = node.dataset.word;
  for (const s of text.match(/[^.!?]+[.!?]*/g) || []) {
    if (s.includes(word)) return s.trim();
  }
  return text.slice(0, 200);
}

function popoverDataFor(word, lemma) {
  const a = state.article?.annotations?.get(word.toLowerCase()) || state.article?.annotations?.get(lemma);
  if (a) return { ipa: a.ipa, common: a.common, context: a.context, source: 'anno' };
  const c = lookupCache()[word.toLowerCase()];
  if (c) return { ...c, source: 'cache' };
  return null;
}

function openPopover(node) {
  const word = node.dataset.word;
  const lemma = node.dataset.lemma;
  state.popoverWord = { word, lemma, node };
  closePopover(false);

  const pop = $('#popover');
  $('#pwWord').textContent = word;
  $('#pwIpa').textContent = '';
  $('#pwCommon').innerHTML = '<span class="pw-loading">正在查词…</span>';
  $('#pwContext').textContent = '';
  $('#pwTip').textContent = '';
  resetUnknownBtn();

  // 定位
  const rect = node.getBoundingClientRect();
  const width = 300;
  let left = rect.left + window.scrollX + rect.width / 2 - width / 2;
  left = Math.max(10, Math.min(left, document.documentElement.scrollWidth - width - 10));
  let top = rect.bottom + window.scrollY + 8;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  pop.classList.remove('hidden');

  const cached = popoverDataFor(word, lemma);
  if (cached) {
    fillPopover(cached);
  } else {
    (async () => {
      try {
        const res = await fetch('/api/lookup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ word, sentence: sentenceOf(node), provider: state.profile.settings.textProvider }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        cacheLookup(word.toLowerCase(), data);
        if (state.popoverWord?.word === word) fillPopover({ ...data, source: 'fresh' });
        renderStats();
      } catch (e) {
        if (state.popoverWord?.word === word) {
          $('#pwCommon').innerHTML = `<span class="status err">查词失败：${e.message}</span>`;
        }
      }
    })();
  }
}

function fillPopover(data) {
  $('#pwIpa').textContent = data.ipa || '';
  $('#pwCommon').innerHTML = data.common ? `<b>常见</b>${esc(data.common)}` : '';
  $('#pwContext').innerHTML = data.context ? `<b>文中</b>${esc(data.context)}` : '';
  $('#pwTip').textContent = data.source === 'anno' ? '本文已预先标注这个词' : '';
}

function closePopover(clearRef = true) {
  $('#popover').classList.add('hidden');
  if (clearRef) state.popoverWord = null;
}

function resetUnknownBtn() {
  const btn = $('#pwUnknown');
  btn.classList.remove('confirm');
  btn.textContent = '❌ 不认识';
  delete btn.dataset.armed;
}

function markKnown() {
  const cur = state.popoverWord;
  if (!cur) return;
  state.profile.knownWords[cur.lemma] = Date.now();
  delete state.profile.unknownWords[cur.lemma];
  saveProfile();
  closePopover();
  if (state.article) renderArticle();
  renderVocabCount();
  toast(`已记住「${cur.word}」，今后不再标注`);
}

function markUnknown() {
  const cur = state.popoverWord;
  if (!cur) return;
  const btn = $('#pwUnknown');
  if (!btn.dataset.armed) {
    // 二次确认，排除误触
    btn.dataset.armed = '1';
    btn.classList.add('confirm');
    btn.textContent = '⚠️ 确认不认识？';
    setTimeout(() => { if (btn.dataset.armed) resetUnknownBtn(); }, 3000);
    return;
  }
  const ipa = $('#pwIpa').textContent || '';
  const common = ($('#pwCommon').textContent || '').replace(/^常见/, '');
  const context = ($('#pwContext').textContent || '').replace(/^文中/, '');
  state.profile.unknownWords[cur.lemma] = { ipa, common, context, addedAt: Date.now() };
  delete state.profile.knownWords[cur.lemma];
  saveProfile();
  closePopover();
  if (state.article) renderArticle();
  renderVocabCount();
  toast(`「${cur.word}」已加入生词本，今后每篇文章都会预先标注它`);
}

// ================= 认词小测（按考纲带位抽样） =================

const QUIZ_LABELS = ['中考', '高考', '四级', '六级', '考研', '雅思', '托福'];

function openQuiz() {
  ensureWordData().then(() => {
    // 每个考纲带位抽 6 个「最早出现在该带位」的常见词（词频前 6 万内）
    const pools = {};
    for (const [w, b] of Object.entries(state.bands)) {
      if (b >= 1 && b <= 7 && (state.freq[w] ?? 999999) <= 60000 && !state.profile.knownWords[w]) {
        (pools[b] || (pools[b] = [])).push(w);
      }
    }
    const items = [];
    for (let b = 1; b <= 7; b++) {
      const pool = pools[b] || [];
      const picked = [];
      while (picked.length < Math.min(6, pool.length)) {
        const w = pool[Math.floor(Math.random() * pool.length)];
        if (!picked.includes(w)) picked.push(w);
      }
      items.push({ band: b, words: picked });
    }
    state.quiz = items;

    const grid = $('#quizGrid');
    grid.innerHTML = '';
    for (const { band, words } of items) {
      const head = document.createElement('div');
      head.className = 'quiz-band';
      head.textContent = `${QUIZ_LABELS[band - 1]}词汇`;
      grid.appendChild(head);
      for (const w of words) {
        const label = document.createElement('label');
        label.className = 'quiz-item';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = w;
        label.append(cb, document.createTextNode(w));
        grid.appendChild(label);
      }
    }
    $('#quizModal').classList.remove('hidden');
  });
}

function submitQuiz() {
  const checked = new Set([...$('#quizGrid input:checked')].map((i) => i.value));
  // 勾选的词直接进已知库
  for (const w of checked) state.profile.knownWords[w] = Date.now();

  // 从低带位往高带位走，掌握率跌破 50% 之前的最高带位即词汇边界
  let band = 1;
  for (const { band: b, words } of state.quiz) {
    const hit = words.filter((w) => checked.has(w)).length;
    const ratio = words.length ? hit / words.length : 1;
    if (ratio >= 0.5) band = b;
    else break;
  }

  const level = LEVELS[band - 1];
  state.profile.level = level.id;
  state.profile.threshold = level.threshold; // 词频兜底阈值同步
  state.profile.calibratedAt = new Date().toISOString();
  saveProfile();

  $('#quizModal').classList.add('hidden');
  refreshLevelUI();
  renderStats();
  toast(`校准完成：你的词汇边界约在${level.label}（${QUIZ_LABELS[band - 1]}及以下考纲词不再标注）`);
}

// ================= 历史 =================

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(LS_HISTORY) || '[]'); } catch { return []; }
}

function saveHistory(article) {
  const h = loadHistory().filter((a) => a.id !== article.id);
  h.unshift(article);
  if (h.length > 30) h.length = 30;
  localStorage.setItem(LS_HISTORY, JSON.stringify(h));
  renderHistory();
}

function renderHistory() {
  const box = $('#historyList');
  const h = loadHistory();
  box.innerHTML = '';
  if (!h.length) { box.innerHTML = '<p class="mini">暂无</p>'; return; }
  for (const a of h) {
    const item = document.createElement('div');
    item.className = 'history-item';
    const t = document.createElement('span');
    t.className = 'ht';
    t.innerHTML = `<strong>${esc(a.title)}</strong> <span class="mini">${new Date(a.createdAt).toLocaleString('zh-CN')} · ${a.list?.length || 0} 词${a.mock ? ' · 演示' : ''}</span>`;
    t.onclick = () => openHistoryArticle(a);
    const del = document.createElement('button');
    del.className = 'ghost';
    del.textContent = '删除';
    del.onclick = () => {
      localStorage.setItem(LS_HISTORY, JSON.stringify(loadHistory().filter((x) => x.id !== a.id)));
      renderHistory();
    };
    item.append(t, del);
    box.appendChild(item);
  }
}

function openHistoryArticle(a) {
  state.article = { ...a, annotations: new Map((a.list || []).map((i) => [String(i.word).toLowerCase(), i])) };
  showReader();
  switchView('read');
  window.scrollTo(0, 0);
}

// ================= 生词本 =================

function renderVocabCount() {
  const n = Object.keys(state.profile.unknownWords || {}).length;
  $('#vocabCount').textContent = n;
}

function renderVocab() {
  const box = $('#vocabList');
  const entries = Object.entries(state.profile.unknownWords || {}).sort((a, b) => (b[1].addedAt || 0) - (a[1].addedAt || 0));
  box.innerHTML = '';
  if (!entries.length) {
    box.innerHTML = '<p class="empty-tip">还没有生词。阅读时点开单词，再点「不认识」即可收藏。</p>';
    return;
  }
  const table = document.createElement('table');
  table.className = 'vocab-table';
  table.innerHTML = '<tr><th>单词</th><th>常见义</th><th>文中义</th><th></th></tr>';
  for (const [word, info] of entries) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="vw">${esc(word)}</span><div class="vc mini">${esc(info.ipa || '')}</div></td>
      <td>${esc(info.common || '')}</td>
      <td>${esc(info.context || '')}</td>
      <td class="ops"></td>`;
    const ops = tr.querySelector('.ops');
    const b1 = document.createElement('button');
    b1.textContent = '已掌握';
    b1.onclick = () => {
      delete state.profile.unknownWords[word];
      state.profile.knownWords[word] = Date.now();
      saveProfile(); renderVocab(); renderVocabCount();
    };
    const b2 = document.createElement('button');
    b2.textContent = '移除';
    b2.onclick = () => {
      delete state.profile.unknownWords[word];
      saveProfile(); renderVocab(); renderVocabCount();
    };
    ops.append(b1, b2);
    table.appendChild(tr);
  }
  box.appendChild(table);
}

// ================= 设置 =================

let localAgents = [];

async function loadAgents() {
  try {
    const res = await fetch('/api/local-agents');
    localAgents = await res.json();
  } catch { localAgents = []; }
  const sel = $('#cliAgent');
  const prev = sel.value;
  sel.innerHTML = localAgents.map((a) =>
    `<option value="${a.id}" ${a.available ? '' : 'disabled'}>${a.label}${a.available ? '' : '（未安装）'}</option>`
  ).join('');
  if (localAgents.some((a) => a.id === prev && a.available)) sel.value = prev;
  else {
    const first = localAgents.find((a) => a.available);
    if (first) sel.value = first.id;
  }
  updateCliAgentInfo();
}

// 展示所选 CLI 配置文件里真正生效的模型与思考强度
function updateCliAgentInfo() {
  const el = $('#cliAgentInfo');
  if (!el) return;
  const a = localAgents.find((x) => x.id === $('#cliAgent').value);
  if (!a) { el.textContent = ''; return; }
  if (!a.model) { el.textContent = '模型：未在配置中检测到（用 CLI 自身默认）'; return; }
  el.textContent = `模型：${a.model}${a.thinking ? ` · 思考强度：${a.thinking}` : ' · 思考强度：未配置'}`;
}

function applyTxtMode(mode) {
  $('#cliRow').classList.toggle('hidden', mode !== 'cli');
  $('#httpRows').classList.toggle('hidden', mode === 'cli');
}

function fillSettings() {
  const s = state.profile.settings;
  const tp = s.textProvider || {};
  const mode = tp.kind === 'cli' ? 'cli' : 'openai';
  $('#txtMode').value = mode;
  applyTxtMode(mode);
  if (mode === 'cli' && tp.cli && localAgents.some((a) => a.id === tp.cli)) $('#cliAgent').value = tp.cli;
  updateCliAgentInfo();
  $('#txtBaseUrl').value = tp.baseUrl || '';
  $('#txtApiKey').value = tp.apiKey || '';
  $('#txtModel').value = tp.model || '';
  $('#visBaseUrl').value = s.visionProvider.baseUrl;
  $('#visApiKey').value = s.visionProvider.apiKey;
  $('#visModel').value = s.visionProvider.model;
  $('#densitySelect').value = s.density || 'first';
}

function currentTextProvider() {
  if ($('#txtMode').value === 'cli') {
    return { kind: 'cli', cli: $('#cliAgent').value };
  }
  return { kind: 'openai', baseUrl: $('#txtBaseUrl').value.trim(), apiKey: $('#txtApiKey').value.trim(), model: $('#txtModel').value.trim() };
}

async function saveSettings() {
  const s = state.profile.settings;
  s.textProvider = currentTextProvider();
  s.visionProvider = { baseUrl: $('#visBaseUrl').value.trim(), apiKey: $('#visApiKey').value.trim(), model: $('#visModel').value.trim() };
  s.density = $('#densitySelect').value;
  saveProfile();
  const st = $('#saveSettingsStatus');
  st.className = 'status ok';
  st.textContent = '已保存 ✓';
  setTimeout(() => { st.textContent = ''; }, 2000);
}

async function testProvider(kind) {
  const st = kind === 'text' ? $('#testTextStatus') : $('#testVisionStatus');
  st.className = 'status';
  st.textContent = '测试中…';
  const provider = kind === 'text'
    ? currentTextProvider()
    : { baseUrl: $('#visBaseUrl').value.trim(), apiKey: $('#visApiKey').value.trim(), model: $('#visModel').value.trim() };
  try {
    const res = await fetch('/api/test-provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || '失败');
    st.className = 'status ok';
    st.textContent = `连接成功：${data.reply}`;
  } catch (e) {
    st.className = 'status err';
    st.textContent = '失败：' + e.message;
  }
}

function renderStats() {
  const p = state.profile;
  const boxes = [
    [p.stats.reads || 0, '已读文章'],
    [p.stats.lookups || 0, '查词次数'],
    [Object.keys(p.knownWords || {}).length, '已掌握词'],
    [Object.keys(p.unknownWords || {}).length, '生词本'],
  ];
  $('#statsRow').innerHTML = boxes.map(([n, l]) => `<div class="stat-box"><div class="num">${n}</div><div class="lbl">${l}</div></div>`).join('');
  const cal = p.calibratedAt
    ? `上次校准：${new Date(p.calibratedAt).toLocaleString('zh-CN')}（${LEVELS.find((l) => l.id === p.level)?.label || p.level}档）`
    : '还没做过认词小测——推荐做一次，档案会更准';
  $('#calibratedInfo').textContent = cal;
}

// ================= 通用 UI =================

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.add('hidden'), 2600);
}

function switchView(name) {
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'vocab') renderVocab();
  if (name === 'settings') { renderStats(); }
}

function switchTab(name) {
  $$('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $('#photoPanel').classList.toggle('hidden', name !== 'photo');
  $('#pastePanel').classList.toggle('hidden', name !== 'paste');
}

function refreshLevelUI() {
  const p = state.profile;
  const level = LEVELS.find((l) => l.id === p.level) || LEVELS[2];
  $('#levelBadge').textContent = level.label.replace(/（.*）/, '');
  for (const sel of [$('#levelSelect'), $('#levelSelect2')]) sel.value = p.level;
  const hint = `${LEVELS.find((l) => l.id === p.level)?.label || ''}考纲内及常用词不标注，超纲生词才标注`;
  $('#thresholdHint').textContent = hint;
  $('#thresholdHint2').textContent = hint;
}

function onLevelChange(value) {
  const level = LEVELS.find((l) => l.id === value);
  if (!level) return;
  state.profile.level = level.id;
  state.profile.threshold = level.threshold;
  saveProfile();
  refreshLevelUI();
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('#themeToggle').textContent = theme === 'dark' ? '☀️' : '🌙';
  localStorage.setItem(LS_THEME, theme);
}

// ================= 初始化 =================

async function init() {
  await loadProfile();
  ensureWordData();

  // 水平下拉
  for (const sel of [$('#levelSelect'), $('#levelSelect2')]) {
    sel.innerHTML = LEVELS.map((l) => `<option value="${l.id}">${l.label}</option>`).join('');
    sel.onchange = (e) => onLevelChange(e.target.value);
  }
  refreshLevelUI();
  await loadAgents();
  fillSettings();
  renderHistory();
  renderVocabCount();
  renderStats();

  applyTheme(localStorage.getItem(LS_THEME) || 'light');

  // 导航与页签
  $$('.nav-btn').forEach((b) => (b.onclick = () => switchView(b.dataset.view)));
  $$('.tab-btn').forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));
  $('#themeToggle').onclick = () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  $('#levelBadge').onclick = () => switchView('settings');
  $('#btnBack').onclick = backToInput;

  // 输入流程
  $('#dropzone').onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = (e) => addImages(e.target.files);
  const dz = $('#dropzone');
  dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('dragover'); };
  dz.ondragleave = () => dz.classList.remove('dragover');
  dz.ondrop = (e) => { e.preventDefault(); dz.classList.remove('dragover'); addImages(e.dataTransfer.files); };
  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); addImages(files); toast('已添加截图，点「开始识别」'); }
  });
  $('#btnTranscribe').onclick = doTranscribe;
  $('#btnAnnotate').onclick = doAnnotate;
  $('#btnExportPdf').onclick = exportPdf;
  $('#densitySelect').onchange = (e) => {
    state.profile.settings.density = e.target.value;
    saveProfile();
    if (state.article) renderArticle();
  };

  // 点词查词
  $('#articleRender').addEventListener('click', (e) => {
    const node = e.target.closest('ruby.anno, span.w');
    if (node) openPopover(node);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#popover') && !e.target.closest('#articleRender')) closePopover();
  });
  $('#pwKnown').onclick = markKnown;
  $('#pwUnknown').onclick = markUnknown;

  // 小测
  $('#btnQuiz').onclick = openQuiz;
  $('#btnQuizCancel').onclick = () => $('#quizModal').classList.add('hidden');
  $('#btnQuizSubmit').onclick = submitQuiz;

  // 设置
  $('#btnSaveSettings').onclick = saveSettings;
  $('#btnTestText').onclick = () => testProvider('text');
  $('#btnTestVision').onclick = () => testProvider('vision');
  $('#txtMode').onchange = (e) => applyTxtMode(e.target.value);
  $('#cliAgent').onchange = updateCliAgentInfo;
  $('#btnRefreshAgents').onclick = async () => {
    const btn = $('#btnRefreshAgents');
    btn.disabled = true;
    await loadAgents();
    fillSettings();
    btn.disabled = false;
    const found = localAgents.filter((a) => a.available).map((a) => a.label).join('、');
    toast(found ? `检测到本机 Agent：${found}` : '没有检测到已安装的 coding CLI');
  };

  // 生词本
  $('#btnExportVocab').onclick = async () => {
    const entries = Object.entries(state.profile.unknownWords || {}).sort((a, b) => (b[1].addedAt || 0) - (a[1].addedAt || 0));
    if (!entries.length) { toast('生词本是空的'); return; }
    const tsv = ['word\tipa\tcommon\tcontext', ...entries.map(([w, i]) => [w, i.ipa || '', i.common || '', i.context || ''].join('\t'))].join('\n');
    await navigator.clipboard.writeText(tsv);
    toast('已复制到剪贴板（TSV 格式，可直接贴进 Excel/Anki）');
  };

  // 数据管理
  $('#btnExportData').onclick = () => {
    const blob = new Blob([JSON.stringify(state.profile, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `reader-profile-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  };
  $('#btnImportData').onclick = () => $('#importFile').click();
  $('#importFile').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.version !== 1) throw new Error('文件格式不对');
      state.profile = { ...state.profile, ...data };
      saveProfile();
      refreshLevelUI(); fillSettings(); renderStats(); renderVocabCount();
      toast('档案已导入');
    } catch (err) {
      toast('导入失败：' + err.message);
    }
  };
  $('#btnClearKnown').onclick = () => {
    if (!confirm('确定清空「已知词库」吗？（已静音的词将重新参与标注）')) return;
    state.profile.knownWords = {};
    saveProfile(); renderStats();
    toast('已知词库已清空');
  };
  $('#btnClearHistory').onclick = () => {
    if (!confirm('确定清空阅读历史吗？')) return;
    localStorage.removeItem(LS_HISTORY);
    renderHistory();
    toast('历史已清空');
  };
}

init().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('afterbegin', `<div style="padding:14px;color:#b91c1c">初始化失败：${esc(e.message)}（请确认本地服务正在运行）</div>`);
});
