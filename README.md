# 📖 ReadBuddy（英语阅读神器）

按**你的**词汇水平，把可能不认识的英文单词预先标注好「常见义 + 文中义」的沉浸式阅读器——读文章时零查词卡顿，视线不打断。

跨平台桌面应用（macOS / Windows / Linux，Electron），也支持纯浏览器模式。

纸质书拍张照，或者把文章粘贴进来，就能得到一篇生词已经标注在单词正下方的文章：

```
      negotiations
   谈判（本文：谈判）
The ────────────── began at the
        fraught
 outset of a ────── session…
      令人担忧的
```

## 快速开始

### 方式一：双击启动（推荐）

克隆或下载本项目后，双击项目目录里的启动文件即可，**无需命令行**（需已安装 [Node.js LTS](https://nodejs.org/)）：

| 系统 | 双击文件 | 说明 |
|---|---|---|
| macOS | `启动ReadBuddy.command` | 首次从网上下载若被 Gatekeeper 拦截，在终端跑一次 `xattr -d com.apple.quarantine 启动ReadBuddy.command` |
| Windows | `启动ReadBuddy.bat` | 杀毒软件误报时允许即可 |
| Linux | `启动ReadBuddy.sh` | 需先 `chmod +x 启动ReadBuddy.sh` |

首次运行会自动安装依赖（需联网，约 1-3 分钟），之后弹出 ReadBuddy 独立窗口。**macOS 上手滑关掉窗口也不会退出**——应用留在 Dock，点图标即恢复，阅读进度与服务都在。

### 方式二：命令行

```bash
npm install

npm start        # 桌面版（Electron 窗口）
npm run web      # 浏览器版，打开 http://127.0.0.1:3456
```

> 首次启动需要联网下载 Electron；若已装好可离线使用（无 Key 时走演示模式，见下）。

## 配置 API Key（设置页）

文本和视觉模型**各自独立配置**，均为 OpenAI 兼容协议，可随时换成任何供应商（如同换 ZCode 的 Provider）：

| 用途 | 默认供应商 | 默认模型 | 说明 |
|---|---|---|---|
| ✍️ 文本模型 | MiniMax | `minimax-m3` | 生词批量标注、点词查词 |
| 📷 视觉模型 | 智谱 AI | `glm-5.3-flash` | 纸质书页拍照转录 |

两个通道也可以**都用 MiniMax**：

- 文本：`https://api.minimaxi.com/v1/text/chatcompletion_v2`（cn 区；global 区用 api.minimax.io）+ 模型 `minimax-m3`
- 视觉：`https://api.minimaxi.com/v1/coding_plan/vlm`（MiniMax 的视觉端点，非 OpenAI 格式，应用已内置适配，多页书页自动逐页转录再拼接；「模型名」一栏随意填写即可）

- 在设置页填入对应平台的 API Key 并「保存配置」即可；MiniMax Key：https://platform.minimaxi.com ；智谱 Key：https://open.bigmodel.cn
- **没有 Key 也能用**：标注接口会返回【演示释义】占位注释，完整流程（阅读、查词卡、认识/不认识、生词本）均可体验

### 💻 本机 Coding Agent 驱动（可选）

文本模型支持第二种驱动方式：直接调用**本机已配置好的 coding CLI**，无需任何 API Key。在设置页把「驱动方式」切到「💻 本机 Coding Agent」，自动检测：

| Agent | 无头调用 |
|---|---|
| Claude Code | `claude -p … --output-format text` |
| Codex CLI | `codex exec --skip-git-repo-check …` |
| OpenCode | `opencode run …` |
| ZCode | `zcode --prompt …` |

选择 agent 后，下拉框下方会显示该 CLI **配置文件里真正生效的模型名与思考强度**（如 `模型：GLM-5.3-Flash · 思考强度：max`）：Claude Code 读 `~/.claude/settings.json` 的 `ANTHROPIC_MODEL` / `CLAUDE_CODE_EFFORT_LEVEL`，Codex 读 `~/.codex/config.toml` 的 `model` / `model_reasoning_effort`，OpenCode 与 ZCode 读各自 config 里 `provider/model` 格式的 `model` 及模型定义中的 `reasoning.defaultVariant`。

标注与查词的提示词会原样发给所选 agent，输出经健壮 JSON 解析后进阅读页；「🔄 重新检测」可刷新已安装列表。适合把订阅制 coding agent 的余量拿来读书。拍照转录仍走视觉模型（云端 API）。

## 功能

- **拍照转录**：上传 / 拖拽 / `Cmd+V` 粘贴书页照片（支持多张），视觉模型逐字转录并保留段落，转录结果先落入可编辑文本框供校对
- **粘贴文本**：直接粘贴英文原文同样可读
- **行内注释**：命中个人生词阈值的词，首次出现时在单词正下方常驻小字中文注释（常见义/文中义/音标）；重复出现改为虚线下划线；注释密度（仅首现/全部）可在设置切换
- **点词查词**：点任意单词弹出查词卡（音标 + 常见义 + 文中义）
- **认识 / 不认识**：点「认识」永久静音该词；点「不认识」需二次确认（防误触），确认后写入你的档案——**今后所有文章都会预先标注它**
- **水平三层判定**：自选档位（中考/高考/四级/六级/考研/雅思/托福）→ 60 秒认词小测自动校准 → 阅读中「认识/不认识」持续修正
- **生词本**：所有「不认识」的词自动收录，可一键复制导出
- **历史文章**：最近 30 篇，点击即重新打开
- **📄 导出 PDF**：阅读页一键把带注释的文章导出为高可读性 A4 PDF（衬线排版、词下青绿小注），桌面版弹原生保存框，浏览器版走系统打印
- 深浅色主题，档案随时导出/导入

## 词汇分级系统（ECDICT 三层判级）

生词判定不再依赖单一词频阈值，而是四层漏斗（[ECDICT](https://github.com/skywind3000/ecdict) 数据，MIT 协议，77 万词条）：

1. **考纲带位**：每个词标注它最早出现的中国考试大纲（中考→高考→四级→六级→考研→雅思→托福→GRE），词的带位高于你选的档位才标注——`modest` 是高考词，选雅思就永远不会被标
2. **词形变换**：`negotiations→negotiate`、`delegates→delegate`、`perceived→perceive` 精确映射到原形（ECDICT exchange 表，含全部不规则变形）
3. **词族回溯**：未收录的透明派生词（`carefully→careful`、`opposition→opposite`）继承词根带位（Bauer & Nation 词族思路；共享前缀 <4 字符的不透明派生不继承）
4. **词频兜底**：完全不在大纲内的词（`sanguine`、`panacea`）按当代语料词频排名判断

构建数据（一般无需重跑，产物已入库）：

```bash
npm run build-wordlist   # 从 ECDICT stardict.csv 生成 data/ 下三个 JSON（约 2MB）
```

认词小测也改为按考纲带位抽样：七个带位各抽 6 词，掌握率跌破 50% 的带位即你的词汇边界。

## 你的档案存在哪

- `data/profile.json`：词汇水平、已知词、生词、使用统计（服务端，桌面/浏览器共用）
- 浏览器 localStorage：历史文章、查词缓存、主题
- API Key 只保存在本机档案中，仅用于直接调用你配置的模型接口

## 数据说明

分级数据来自 [ECDICT](https://github.com/skywind3000/ecdict)（见上文「词汇分级系统」），已入库无需重建；如需重建：`npm run build-wordlist`。

## 项目结构

```
├── 启动ReadBuddy.command/.bat/.sh # 三平台双击启动器
├── electron/main.js           # Electron 主进程（内嵌 Express）
├── electron/preload.js        # 渲染进程桥（PDF 导出 IPC）
├── electron/export.js         # printToPDF 导出共享模块
├── scripts/e2e-export-test.js # 导出链路无头 e2e 测试
├── server.js                  # Express 服务 + LLM 代理接口
├── scripts/build-wordlist.js  # ECDICT → 分级数据构建脚本
├── data/wordbands.json        # 考纲带位表（构建产物）
├── data/exchange.json         # 词形→原形映射（构建产物）
├── data/freq.json             # 词频兜底表（构建产物）
├── data/profile.json          # 读者档案（运行时生成）
├── data/llm-log.jsonl         # LLM 调用日志（运行时生成，/api/llm-log 可查）
└── public/                    # 前端单页应用（无构建步骤）
    ├── index.html
    ├── style.css
    └── app.js
```
