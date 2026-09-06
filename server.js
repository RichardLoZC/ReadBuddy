// ReadBuddy（英语阅读神器）· 本地服务
// 静态托管前端 + LLM 代理接口（转录/标注/查词）+ 读者档案存储
// LLM 走 OpenAI 兼容协议，文本/视觉两个 Provider 独立配置（默认：minimax-m3 / glm-5.3-flash）
const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const PORT = Number(process.env.PORT || 3456);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.join(__dirname, 'data');
const PROFILE_PATH = path.join(DATA_DIR, 'profile.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/data', express.static(DATA_DIR));

// ---------------- 读者档案 ----------------

const DEFAULT_PROFILE = {
  version: 1,
  level: 'cet4',          // 自评档位（展示用）
  threshold: 5000,        // 词频排名阈值：排名 > 此值的词视为潜在生词（小测可校准）
  calibratedAt: null,     // 上次小测校准时间
  knownWords: {},         // lemma -> 时间戳（这些词不再标注）
  unknownWords: {},       // lemma -> {ipa, common, context, addedAt}（永远标注 + 进生词本）
  stats: { reads: 0, lookups: 0 },
  settings: {
    textProvider: {       // 标注 / 查词
      baseUrl: 'https://api.minimax.chat/v1/text/chatcompletion_v2',
      apiKey: '',
      model: 'minimax-m3',
    },
    visionProvider: {     // 拍照转录 / 视觉验收
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: '',
      model: 'glm-5.3-flash',
    },
    density: 'first',     // 注释密度：first=仅首现直标 / all=全部直标
  },
};

function readProfile() {
  try {
    const saved = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
    return {
      ...DEFAULT_PROFILE,
      ...saved,
      stats: { ...DEFAULT_PROFILE.stats, ...(saved.stats || {}) },
      settings: {
        ...DEFAULT_PROFILE.settings,
        ...(saved.settings || {}),
        textProvider: { ...DEFAULT_PROFILE.settings.textProvider, ...(saved.settings?.textProvider || {}) },
        visionProvider: { ...DEFAULT_PROFILE.settings.visionProvider, ...(saved.settings?.visionProvider || {}) },
      },
    };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_PROFILE));
  }
}

function writeProfile(p) {
  fs.writeFileSync(PROFILE_PATH, JSON.stringify(p, null, 2));
}

const LEVEL_LABELS = {
  zhongkao: '初中（中考）', gaokao: '高中（高考）', cet4: '大学四级', cet6: '大学六级',
  kaoyan: '考研', ielts: '雅思', toefl: '托福/进阶',
};

function profileSummary(profile) {
  const label = LEVEL_LABELS[profile.level] || profile.level;
  const cal = profile.calibratedAt ? '（已经认词小测校准）' : '（自估档位）';
  return `读者画像：中国英语学习者，水平约 ${label}${cal}，${label}及以下考纲词汇（中考/高考/四六级/考研/雅思/托福大纲）和常用词应已掌握，只有超出该档位的超纲词才可能不认识，释义请贴合此水平。`;
}

// ---------------- LLM 调用（OpenAI 兼容） ----------------

// 兼容各种 Base URL 写法：
//   https://open.bigmodel.cn/api/paas/v4                 -> +/chat/completions
//   https://api.openai.com/v1                            -> +/chat/completions
//   https://api.minimax.chat/v1/text/chatcompletion_v2   -> 原样（MiniMax 特有路径）
//   https://api.minimaxi.com/v1/coding_plan/vlm          -> 原样（MiniMax 视觉特有路径，走下方 vlm 适配）
//   …/chat/completions                                   -> 原样
function endpointUrl(base) {
  const b = String(base || '').trim().replace(/\/+$/, '');
  if (!b) throw new Error('未配置 API Base URL');
  if (/\/chat\/completions$/i.test(b) || /chatcompletion/i.test(b) || /\/coding_plan\/vlm$/i.test(b)) return b;
  return b + '/chat/completions';
}

// 带重试的 LLM 调用 harness：
//  - finish_reason=length（推理/正文被截断，含「内容为空」变体）→ max_tokens 翻倍重试
//  - HTTP 5xx / 429 / MiniMax 偶发 system error → 退避重试
//  - 4xx 参数错误 → 立即抛出不重试
// 每次尝试都写入 data/llm-log.jsonl
async function chatLLM(provider, messages, { kind = 'chat', maxTokens = 4096, temperature = 0.2, timeoutMs = 180000, maxAttempts = 3, capTokens = 32000 } = {}) {
  if (provider?.kind === 'cli') {
    const t0 = Date.now();
    try {
      const out = await cliChat(provider, messages, { timeoutMs });
      llmLog({ kind, engine: 'cli:' + provider.cli, attempt: 1, ok: true, ms: Date.now() - t0, chars: out.length });
      return out;
    } catch (e) {
      llmLog({ kind, engine: 'cli:' + provider.cli, attempt: 1, ok: false, ms: Date.now() - t0, error: String(e.message).slice(0, 200) });
      throw e;
    }
  }
  if (!provider || !provider.apiKey) {
    const err = new Error('NO_KEY');
    err.code = 'NO_KEY';
    throw err;
  }
  const engine = provider.model || 'llm';
  let budget = Math.min(capTokens, maxTokens);
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(endpointUrl(provider.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
        body: JSON.stringify({ model: provider.model, messages, temperature, max_tokens: budget }),
        signal: ctrl.signal,
      });
      if (res.status === 429 || res.status >= 500) {
        const err = new Error(`LLM HTTP ${res.status}`);
        err.retryable = true;
        throw err;
      }
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
      const data = await res.json();
      if (data?.base_resp?.status_code && data.base_resp.status_code !== 0) {
        const err = new Error(`LLM ${data.base_resp.status_code}: ${data.base_resp.status_msg}`);
        // MiniMax 1033 system error 等偶发错误可重试；2013 模型名错误等参数问题不重试
        err.retryable = data.base_resp.status_code === 1033;
        throw err;
      }
      const choice = data?.choices?.[0];
      const content = choice?.message?.content;
      const finish = choice?.finish_reason || '';
      llmLog({
        kind, engine, attempt, ok: !!((typeof content === 'string' && content.trim()) && finish !== 'length'),
        finish, ms: Date.now() - t0, maxTokens: budget,
        tokens: data?.usage ? { p: data.usage.prompt_tokens, c: data.usage.completion_tokens } : undefined,
        chars: typeof content === 'string' ? content.length : 0,
      });
      if (finish === 'length') {
        // 推理模型（如 minimax-m3）思考+正文超出预算被截断：翻倍预算重试
        lastErr = new Error('输出被截断（max_tokens 耗尽）');
        if (budget >= capTokens) throw lastErr;
        budget = Math.min(capTokens, budget * 2);
        await sleep(1200);
        continue;
      }
      if (typeof content !== 'string' || !content.trim()) {
        lastErr = new Error('LLM 返回内容为空: ' + JSON.stringify(data).slice(0, 200));
        await sleep(1200);
        continue;
      }
      return content;
    } catch (e) {
      const retryable = e.retryable || e.name === 'AbortError' || /fetch failed|network/i.test(String(e.message));
      llmLog({ kind, engine, attempt, ok: false, ms: Date.now() - t0, maxTokens: budget, error: String(e.message).slice(0, 200) });
      if (!retryable || attempt >= maxAttempts) throw e;
      lastErr = e;
      await sleep(1500 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('LLM 调用失败');
}

function extractJSON(s) {
  const t = String(s).replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(t); } catch { /* 继续尝试截取 */ }
  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    const i = t.indexOf(open);
    const j = t.lastIndexOf(close);
    if (i !== -1 && j > i) {
      try { return JSON.parse(t.slice(i, j + 1)); } catch { /* 换下一对 */ }
    }
  }
  throw new Error('无法从 LLM 输出中解析 JSON');
}

// MiniMax 视觉特有端点 /v1/coding_plan/vlm 的适配：
// 请求 {prompt, image_url}（单图）、响应 {content, base_resp}，均非 OpenAI 格式。
// 仅当视觉 Provider 的 Base URL 指向该端点时启用，其他供应商仍走通用 OpenAI 通道。
function isVlmProvider(provider) {
  return /\/coding_plan\/vlm\/?$/i.test(String(provider?.baseUrl || '').trim());
}

async function vlmChat(provider, prompt, imageUrl, { timeoutMs = 180000 } = {}) {
  if (!provider || !provider.apiKey) {
    const err = new Error('NO_KEY');
    err.code = 'NO_KEY';
    throw err;
  }
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(endpointUrl(provider.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify({ prompt, image_url: imageUrl }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`VLM HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
    const data = await res.json();
    if (data?.base_resp?.status_code && data.base_resp.status_code !== 0) {
      throw new Error(`VLM ${data.base_resp.status_code}: ${data.base_resp.status_msg}`);
    }
    const content = data?.content;
    llmLog({ kind: 'vlm', engine: 'minimax-vlm', attempt: 1, ok: typeof content === 'string' && !!content.trim(), ms: Date.now() - t0, chars: typeof content === 'string' ? content.length : 0 });
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('VLM 返回内容为空: ' + JSON.stringify(data).slice(0, 300));
    }
    return content;
  } catch (e) {
    llmLog({ kind: 'vlm', engine: 'minimax-vlm', attempt: 1, ok: false, ms: Date.now() - t0, error: String(e.message).slice(0, 200) });
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------- 本机 Coding Agent CLI（可选文本引擎） ----------------
// 无头调用本机已配置好的 coding CLI 来做标注/查词，无需 API Key。
// 各 CLI 的无头模式：
//   claude   -p <prompt> --output-format text
//   codex    exec --skip-git-repo-check <prompt>
//   opencode run <prompt>
//   zcode    --prompt <prompt>
const AGENT_CLIS = [
  { id: 'claude', label: 'Claude Code', bin: 'claude', args: (p) => ['-p', p, '--output-format', 'text'] },
  { id: 'codex', label: 'Codex CLI', bin: 'codex', args: (p) => ['exec', '--skip-git-repo-check', p] },
  { id: 'opencode', label: 'OpenCode', bin: 'opencode', args: (p) => ['run', p] },
  { id: 'zcode', label: 'ZCode', bin: 'zcode', args: (p) => ['--prompt', p] },
];

const IS_WIN = process.platform === 'win32';

function whichBin(bin) {
  // Windows 没有 which，用 where（npm 全局装的 CLI 是 .cmd 垫片，也靠 where 找）
  return new Promise((resolve) => {
    execFile(IS_WIN ? 'where' : 'which', [bin], { timeout: 5000 }, (err, stdout) => {
      resolve(err || !stdout.trim() ? null : stdout.trim().split('\n')[0].trim());
    });
  });
}

// ---------------- 本机 Agent 的模型 / 思考强度检测 ----------------
// 各 CLI 真正调用的模型存在它自己的配置文件里，读出来给设置页展示：
//   claude    ~/.claude/settings.json  env.ANTHROPIC_MODEL / env.CLAUDE_CODE_EFFORT_LEVEL
//   codex     ~/.codex/config.toml     model / model_reasoning_effort
//   opencode  ~/.config/opencode/opencode.json（或 ~/.opencode.json）model: "provider/model"
//   zcode     ~/.zcode/cli/config.json 同 opencode 格式，思考档在
//             provider.<id>.models.<name>.reasoning.defaultVariant
function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Windows 的家目录在 USERPROFILE（HOME 常常没有）
function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || '';
}

function agentModelInfo(id) {
  const home = homeDir();
  if (id === 'claude') {
    const s = readJsonSafe(path.join(home, '.claude', 'settings.json')) || {};
    const env = s.env || {};
    return {
      model: env.ANTHROPIC_MODEL || s.model || '',
      thinking: env.CLAUDE_CODE_EFFORT_LEVEL || (s.alwaysThinkingEnabled ? 'on' : ''),
    };
  }
  if (id === 'codex') {
    let toml = '';
    try { toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'); } catch { /* 未安装 */ }
    return {
      model: (toml.match(/^\s*model\s*=\s*"([^"]+)"/m) || [])[1] || '',
      // codex 未配置时默认 medium
      thinking: (toml.match(/^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m) || [])[1] || 'medium（默认）',
    };
  }
  if (id === 'opencode' || id === 'zcode') {
    const files = id === 'opencode'
      ? [path.join(home, '.config', 'opencode', 'opencode.json'), path.join(home, '.opencode.json')]
      : [path.join(home, '.zcode', 'cli', 'config.json')];
    const s = files.map(readJsonSafe).find(Boolean) || {};
    const full = s.model || '';
    let model = full;
    let thinking = '';
    const slash = full.indexOf('/');
    if (slash > 0) {
      const provId = full.slice(0, slash);
      const modelName = full.slice(slash + 1);
      if (modelName) model = modelName;
      const r = s.provider?.[provId]?.models?.[modelName]?.reasoning;
      if (r?.enabled) thinking = r.defaultVariant || 'on';
    }
    return { model, thinking };
  }
  return { model: '', thinking: '' };
}

// Windows 下 npm 装的 CLI 是 .cmd 垫片，Node 无法直接 spawn，要经 cmd.exe 转发并手工转义引号
function spawnCli(bin, args) {
  if (!IS_WIN) {
    return spawn(bin, args, { cwd: __dirname, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  return spawn('cmd.exe', ['/d', '/s', '/c', [bin, ...args].map(q).join(' ')], {
    cwd: __dirname, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    windowsVerbatimArguments: true,
  });
}

function cliChat(provider, messages, { timeoutMs = 180000 } = {}) {
  const agent = AGENT_CLIS.find((a) => a.id === provider.cli);
  if (!agent) throw new Error(`未知的本机 Agent：${provider.cli}`);
  const prompt = messages.map((m) => {
    const c = m.content;
    const text = typeof c === 'string'
      ? c
      : Array.isArray(c) ? c.filter((x) => x?.type === 'text').map((x) => x.text).join('\n') : '';
    return m.role === 'system' ? `[系统指令]\n${text}` : text;
  }).filter(Boolean).join('\n\n');
  return new Promise((resolve, reject) => {
    const child = spawnCli(agent.bin, agent.args(prompt));
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${agent.label} 响应超时（${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`无法启动 ${agent.label}：${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = out.trim();
      if (!text) {
        reject(new Error(`${agent.label} 没有输出${code ? `（退出码 ${code}）` : ''}${err ? '：' + err.slice(-300) : ''}`));
      } else {
        resolve(text);
      }
    });
  });
}

// ---------------- LLM 调用日志 ----------------
// 每次调用（含每次重试）追加一行到 data/llm-log.jsonl，可经 GET /api/llm-log 查看
const LLM_LOG_PATH = path.join(DATA_DIR, 'llm-log.jsonl');
function llmLog(entry) {
  try {
    fs.appendFileSync(LLM_LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* 日志失败不影响主流程 */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 接口 ----------------

// 检测本机可用的 coding agent（附带各自配置的模型名与思考强度）
app.get('/api/local-agents', async (_req, res) => {
  const list = await Promise.all(AGENT_CLIS.map(async (a) => ({
    id: a.id,
    label: a.label,
    available: !!(await whichBin(a.bin)),
    ...agentModelInfo(a.id),
  })));
  res.json(list);
});

// 查看最近的 LLM 调用日志（默认 50 条，data/llm-log.jsonl）
app.get('/api/llm-log', (req, res) => {
  const n = Math.min(200, Number(req.query.n) || 50);
  try {
    const lines = fs.readFileSync(LLM_LOG_PATH, 'utf8').trim().split('\n').filter(Boolean);
    res.json(lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
  } catch {
    res.json([]);
  }
});

app.get('/api/health', (_req, res) => {
  const p = readProfile();
  res.json({
    ok: true,
    hasTextKey: !!p.settings.textProvider.apiKey,
    hasVisionKey: !!p.settings.visionProvider.apiKey,
  });
});

app.get('/api/profile', (_req, res) => res.json(readProfile()));

app.put('/api/profile', (req, res) => {
  const p = req.body;
  if (!p || typeof p !== 'object' || p.version !== 1) {
    return res.status(400).json({ error: '非法档案数据' });
  }
  writeProfile(p);
  res.json({ ok: true });
});

// 测试某个 Provider 连通性
app.post('/api/test-provider', async (req, res) => {
  const { provider } = req.body;
  // MiniMax vlm 端点不支持纯文本，用 1px 图片做连通性测试
  const PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  try {
    const reply = isVlmProvider(provider)
      ? (await vlmChat(provider, '连接测试，请只回复两个字母：OK', PIXEL_PNG, { timeoutMs: 60000 })).slice(0, 50)
      : await chatLLM(provider, [
          { role: 'user', content: '连接测试，请只回复两个字母：OK' },
        ], { kind: 'test', maxTokens: 1024, temperature: 0, timeoutMs: provider?.kind === 'cli' ? 90000 : 30000 });
    res.json({ ok: true, reply: reply.slice(0, 50) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.code === 'NO_KEY' ? '未填写 API Key' : e.message });
  }
});

// ---- 拍照转录（多模态） ----

app.post('/api/transcribe', async (req, res) => {
  const { images = [], provider } = req.body;
  const profile = readProfile();
  const prov = provider || profile.settings.visionProvider;
  if (!Array.isArray(images) || !images.length) return res.status(400).json({ error: '没有图片' });

  const prompt = [
    '你是精准的 OCR 助手，帮助一位中国英语学习者把纸质书页的照片转成文字。要求：',
    '1. 逐字转录图片中的英文正文，保持原文拼写、标点、大小写；',
    '2. 保留段落结构：段与段之间用一个空行分隔；',
    '3. 忽略页眉、页脚、页码、手写笔记和装饰；',
    '4. 不要翻译，不要添加任何解释、前后缀或 Markdown 代码块，只输出纯文本正文；',
    '5. 多张图片是同一篇文章的连续部分，按顺序拼接成一篇，中间不要输出分隔符。',
  ].join('\n');

  try {
    if (isVlmProvider(prov)) {
      // MiniMax vlm 端点一次只收一张图：逐页转录后按序拼接
      const pagePrompt = [
        '你是精准的 OCR 助手，帮助一位中国英语学习者把纸质书页的照片转成文字。要求：',
        '1. 逐字转录这张图片中的英文正文，保持原文拼写、标点、大小写；',
        '2. 保留段落结构：段与段之间用一个空行分隔；',
        '3. 忽略页眉、页脚、页码、手写笔记和装饰；',
        '4. 不要翻译，不要添加任何解释、前后缀或 Markdown 代码块，只输出纯文本正文。',
      ].join('\n');
      const parts = [];
      for (const url of images.slice(0, 12)) {
        parts.push((await vlmChat(prov, pagePrompt, url)).trim());
      }
      return res.json({ text: parts.filter(Boolean).join('\n\n') });
    }
    const content = [
      { type: 'text', text: prompt },
      ...images.slice(0, 12).map((url) => ({ type: 'image_url', image_url: { url } })),
    ];
    const out = await chatLLM(prov, [{ role: 'user', content }], { kind: 'transcribe', maxTokens: 16000, temperature: 0 });
    res.json({ text: out.trim() });
  } catch (e) {
    if (e.code === 'NO_KEY') {
      return res.status(400).json({ error: '尚未配置视觉模型 API Key，请到「设置」填写（默认 glm-5.3-flash / 智谱开放平台）' });
    }
    res.status(500).json({ error: e.message });
  }
});

// ---- 批量标注 ----

function mockAnnotate(words) {
  return {
    mock: true,
    list: words.map((w) => ({ word: w, ipa: '/·/', common: '【演示释义】常见含义', context: '【演示释义】文中含义' })),
    extras: [],
  };
}

function splitIntoChunks(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const paras = text.split(/\n{2,}/);
  const chunks = [];
  let cur = '';
  for (const p of paras) {
    if (cur && (cur + '\n\n' + p).length > maxChars) { chunks.push(cur); cur = p; }
    else cur = cur ? cur + '\n\n' + p : p;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function annotatePrompt(profile, chunk, words) {
  return [
    profileSummary(profile),
    '',
    '下面是文章片段：',
    '<article>',
    chunk,
    '</article>',
    '',
    '候选生词表（JSON 数组，按出现顺序，均为该读者可能不认识的词）：',
    JSON.stringify(words),
    '',
    '任务：为每个候选词输出：',
    '- word：原样返回该词（必须与候选表一致）',
    '- ipa：英式音标，如 /fraʊt/',
    '- common：该词最常见的 1-2 个中文释义，尽量简短（不超过 12 字）',
    '- context：它在上面文章语境中的具体中文释义（与 common 相同时也要写出；多义词必须给语境义），不超过 14 字',
    '',
    '另外：如果你发现文中还有该读者大概率不认识、但候选表未包含的生词或短语（含动词短语、习语），',
    '放入 extras 数组（最多 15 个，字段同上，word 用原文中的词或短语）。',
    '',
    '严格只输出 JSON，格式：{"list":[{"word":"...","ipa":"...","common":"...","context":"..."}],"extras":[]}',
  ].join('\n');
}

app.post('/api/annotate', async (req, res) => {
  const { text, words = [], provider } = req.body;
  const profile = readProfile();
  const prov = provider || profile.settings.textProvider;
  if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: '没有文章内容' });
  if (!Array.isArray(words) || !words.length) return res.json({ list: [], extras: [] });
  if (prov.kind !== 'cli' && !prov.apiKey) return res.json(mockAnnotate(words)); // 演示模式：无 Key 也能体验全流程

  try {
    const chunks = splitIntoChunks(text, 12000);
    const merged = { list: [], extras: [] };
    const seen = new Set();
    const seenExtra = new Set();
    // 单次调用的候选词上限：推理模型（如 minimax-m3）思考+输出的 token 随词数暴涨，
    // 超大候选集一次调用极易在 max_tokens 处截断；分组并行调用再合并，从结构上约束输出规模。
    const WORD_GROUP = 60;
    for (const chunk of chunks) {
      const lower = chunk.toLowerCase();
      const chunkWords = words.filter((w) => lower.includes(String(w).toLowerCase()));
      if (!chunkWords.length) continue;
      const groups = [];
      for (let i = 0; i < chunkWords.length; i += WORD_GROUP) groups.push(chunkWords.slice(i, i + WORD_GROUP));
      const groupResults = await Promise.all(groups.map(async (group) => {
        const messages = [
          { role: 'system', content: '你是专业的英语阅读助教，为中国学习者预处理英文文章。严格遵守：只输出 JSON，不要任何解释或 Markdown。' },
          { role: 'user', content: annotatePrompt(profile, chunk, group) },
        ];
        // JSON 解析失败（如输出仍被截断）时原样重试一次
        for (let tries = 0; tries < 2; tries++) {
          const raw = await chatLLM(prov, messages, {
            kind: 'annotate',
            maxTokens: Math.min(32000, Math.max(12000, group.length * 250)),
            temperature: 0.2,
            timeoutMs: 240000,
          });
          try {
            return extractJSON(raw);
          } catch (e) {
            llmLog({ kind: 'annotate', engine: prov.model, ok: false, error: 'JSON 解析失败', head: String(raw).slice(0, 150) });
            if (tries >= 1) throw e;
          }
        }
      }));
      for (const parsed of groupResults) {
        for (const item of parsed?.list || []) {
        if (item && item.word && !seen.has(String(item.word).toLowerCase())) {
          seen.add(String(item.word).toLowerCase());
          merged.list.push(item);
        }
      }
      for (const item of parsed?.extras || []) {
          if (item && item.word && !seenExtra.has(String(item.word).toLowerCase())) {
            seenExtra.add(String(item.word).toLowerCase());
            merged.extras.push(item);
          }
        }
      }
    }
    res.json(merged);
  } catch (e) {
    res.status(500).json({ error: '标注失败：' + e.message });
  }
});

// ---- 随时点词查词 ----

app.post('/api/lookup', async (req, res) => {
  const { word, sentence = '', provider } = req.body;
  const profile = readProfile();
  const prov = provider || profile.settings.textProvider;
  if (!word) return res.status(400).json({ error: '没有单词' });

  try {
    const raw = await chatLLM(
      prov,
      [
        { role: 'system', content: '你是随身英语词典，给中国学习者查词。严格遵守：只输出 JSON，不要任何解释。' },
        {
          role: 'user',
          content: [
            profileSummary(profile),
            `要查的单词：${word}`,
            sentence ? `它出现在这句话里：\n${sentence}` : '（没有上下文句子）',
            '',
            '输出 JSON：{"ipa":"英式音标","common":"最常见的1-2个中文释义，简短","context":"在上面句子语境中的中文释义；没有上下文就与 common 相同"}',
          ].join('\n'),
        },
      ],
      { kind: 'lookup', maxTokens: 6000, temperature: 0.2, timeoutMs: 90000 },
    );
    const parsed = extractJSON(raw);
    const p = readProfile();
    p.stats.lookups = (p.stats.lookups || 0) + 1;
    writeProfile(p);
    res.json({ ipa: parsed.ipa || '', common: parsed.common || '', context: parsed.context || parsed.common || '' });
  } catch (e) {
    if (e.code === 'NO_KEY') return res.status(400).json({ error: '尚未配置文本模型 API Key（默认 minimax-m3 / MiniMax）' });
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`ReadBuddy 已启动: http://${HOST}:${PORT}`);
});
