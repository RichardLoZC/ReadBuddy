// 离线验证：分词 + 词频匹配（与 public/app.js 中 IRREG/variants/bestRank/findCandidates 逻辑一致）
// 用一段《经济学人》风格样文检查候选生词是否合理：常见词不该进、超纲词该进
const freq = require('../data/freq.json');

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
  hid: 'hide', hidden: 'hide', rose: 'rise', risen: 'rise', shook: 'shake', shaken: 'shake',
  sank: 'sink', sunk: 'sink', rang: 'ring', rung: 'ring', sang: 'sing', sung: 'sing',
  swam: 'swim', swum: 'swim', laid: 'lay', struck: 'strike', froze: 'freeze', frozen: 'freeze',
  stole: 'steal', stolen: 'steal', swore: 'swear', sworn: 'swear', tore: 'tear', torn: 'tear',
  bore: 'bear', borne: 'bear', beat: 'beat', bound: 'bind', bled: 'bleed', bred: 'breed',
  blew: 'blow', blown: 'blow', bent: 'bend', bit: 'bite', bitten: 'bite', crept: 'creep', dug: 'dig',
  fed: 'feed', fled: 'flee', hung: 'hang', knelt: 'kneel', lit: 'light', rode: 'ride', ridden: 'ride',
  slid: 'slide', spun: 'spin', stuck: 'stick', stung: 'sting', woke: 'wake', woken: 'wake',
  wove: 'weave', woven: 'weave', withdrew: 'withdraw', withdrawn: 'withdraw',
  children: 'child', men: 'man', women: 'woman', feet: 'foot', teeth: 'tooth', mice: 'mouse',
  geese: 'goose', oxen: 'ox', halves: 'half', knives: 'knife', wives: 'wife', lives: 'life',
  leaves: 'leaf', loaves: 'loaf', wolves: 'wolf', shelves: 'shelf', thieves: 'thief', calves: 'calf',
};

function variants(w) {
  const out = new Set([w]);
  const add = (s) => { if (s && s.length >= 2) out.add(s); };
  if (w.endsWith('ies') && w.length > 4) add(w.slice(0, -3) + 'y');
  if (/(?:ses|xes|zes|ches|shes)$/.test(w)) add(w.slice(0, -2));
  else if (w.endsWith('es') && w.length > 3) { add(w.slice(0, -2)); add(w.slice(0, -1)); }
  else if (w.endsWith('s') && !w.endsWith('ss') && w.length > 2) add(w.slice(0, -1));
  if (w.endsWith('ied') && w.length > 4) add(w.slice(0, -3) + 'y');
  if (w.endsWith('ed') && w.length > 3) {
    add(w.slice(0, -2)); add(w.slice(0, -2) + 'e'); add(w.slice(0, -1));
    if (w.length > 4 && /(.)\1ed$/.test(w)) add(w.slice(0, -3));
  }
  if (w.endsWith('ing') && w.length > 4) {
    add(w.slice(0, -3)); add(w.slice(0, -3) + 'e');
    if (w.length > 5 && /(.)\1ing$/.test(w)) add(w.slice(0, -4));
  }
  if (w.endsWith('er') && w.length > 4) { add(w.slice(0, -1)); add(w.slice(0, -2)); if (w.length > 4 && /(.)\1er$/.test(w)) add(w.slice(0, -3)); }
  if (w.endsWith('est') && w.length > 4) { add(w.slice(0, -2)); add(w.slice(0, -3)); if (w.length > 5 && /(.)\1est$/.test(w)) add(w.slice(0, -4)); }
  if (w.endsWith('ly') && w.length > 4) add(w.slice(0, -2));
  if (w.endsWith('ves') && w.length > 4) { add(w.slice(0, -3) + 'f'); add(w.slice(0, -3) + 'fe'); }
  return out;
}

function bestRank(raw) {
  let w = raw.toLowerCase().replace(/’/g, "'");
  const resolve = (x) => IRREG[x] || x;
  w = resolve(w);
  const special = { "won't": 'will', "can't": 'can', cannot: 'can', "shan't": 'shall' };
  if (special[w]) {
    w = special[w];
  } else {
    const contr = w.match(/^(.+?)n't$/) || w.match(/^(.+?)'(?:s|re|ve|ll|m|d)$/);
    if (contr) w = resolve(contr[1]);
  }
  let best = null;
  for (const cand of variants(w)) {
    const r = freq[cand];
    if (r !== undefined && (best === null || r < best.rank)) best = { lemma: cand, rank: r };
  }
  return best || { lemma: w, rank: Infinity };
}

function findCandidates(text, threshold, knownWords = {}, unknownWords = {}) {
  const re = /[A-Za-z][A-Za-z'’-]*/g;
  const seen = new Set();
  const forced = [];
  const cands = [];
  let m;
  while ((m = re.exec(text))) {
    const best = bestRank(m[0]);
    if (knownWords[best.lemma] || seen.has(best.lemma)) continue;
    seen.add(best.lemma);
    if (unknownWords[best.lemma]) { forced.push(m[0]); continue; }
    if (best.rank === Infinity || best.rank > threshold) cands.push({ word: m[0], rank: best.rank });
  }
  return { forced, cands: cands.slice(0, 150) };
}

const SAMPLE = `The negotiations were fraught with difficulty from the outset. Delegates from seventeen nations gathered in the cavernous hall, each clinging to an intransigent position that made compromise seem illusory.

"We cannot simply capitulate to these untenable demands," the British envoy remonstrated, his voice echoing beneath the ornate chandeliers. His counterpart, a seasoned diplomat renowned for her pragmatism, remained sanguine despite the impasse. She believed that prolonged deliberation would eventually engender a semblance of consensus.

Outside, protesters brandished placards decrying the perceived inequity of the proposed accord, while journalists scribbled feverishly, eager to prognosticate the outcome. The stakes were ostensibly economic, yet everyone understood the subterranean geopolitical currents that coursed beneath the rhetoric.`;

// —— 四级读者（阈值 5000）——
const { cands } = findCandidates(SAMPLE, 5000);
console.log('四级读者候选生词（%d 个）：', cands.length);
for (const c of cands) console.log('  ', c.word.padEnd(18), c.rank === Infinity ? '(>50000)' : `#${c.rank}`);

// —— 六级读者（阈值 6500）：候选应变少 ——
const r2 = findCandidates(SAMPLE, 6500);
console.log('\n六级读者候选生词数：', r2.cands.length);

// —— 断言 ——
const got = new Set(cands.map((c) => c.word.toLowerCase()));
const mustHave = ['fraught', 'intransigent', 'illusory', 'capitulate', 'untenable', 'sanguine', 'engender', 'prognosticate'];
// 注：gathered(#6867)/beneath(#7693) 排名确实超过四级阈值 5000，按设计属于应标词，不算误标
const mustNot = ['the', 'a', 'she', 'we', 'his', 'outside', 'understood', 'cannot', 'everyone'];
let fail = 0;
for (const w of mustHave) if (!got.has(w)) { console.error('❌ 缺失应标词:', w); fail++; }
for (const w of mustNot) if (got.has(w)) { console.error('❌ 误标常见词:', w); fail++; }

// —— 缩约词与所有格：功能词不产生候选（专有名词 John's 除外）——
const r3 = findCandidates("She didn't believe it wasn't true, and they've said it won't start. I can't agree.", 5000);
const got3 = new Set(r3.cands.map((c) => c.word.toLowerCase()));
if (got3.size) { console.error('❌ 缩约词测试出现候选:', [...got3]); fail++; }

// —— known/unknown 档案交互 ——
const r4 = findCandidates('The fraught negotiation continued.', 5000, { negotiation: 1 }, { continue: 1 });
const words4 = [...r4.forced.map((w) => w.toLowerCase()), ...r4.cands.map((c) => c.word.toLowerCase())];
if (words4.includes('negotiation')) { console.error('❌ 已知词仍被标出'); fail++; }
if (!words4.includes('continued')) { console.error('❌ 生词本词未被强制标注'); fail++; }

// —— 不规则变形抽查 ——
for (const [form, base] of [['understood', 'understand'], ['bought', 'buy'], ['children', 'child'], ['knives', 'knife']]) {
  const r = bestRank(form);
  if (r.lemma !== base) { console.error(`❌ ${form} 未还原为 ${base}（得到 ${r.lemma}）`); fail++; }
}

console.log(fail ? `\n${fail} 项断言失败` : '\n✅ 全部断言通过');
process.exit(fail ? 1 : 0);
