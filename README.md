# No-AI 去AI味服务

把带模型腔调的文字改成自然的人写文字，同时保证事实不丢、不乱换词。可作为在线 Web 服务部署，也提供 API。

## 为什么不是又一个“同义词替换器”

设计来自两部分经验：

1. **自动出题流水线的返修记录**（`AI-Question-Generate`）：去 AI 改写曾多次丢掉场景、把“真实输入”改成“测试输入”、漏掉格式名和排他条件、凭空造主体；只换同义词的稿子相似度过高被退回；批量产出共享同一套骨架。
2. **开源项目与配对语料研究**：blader/humanizer、op7418/Humanizer-zh、avoid-ai-writing、lieflat-less-ai-tone（520 万字配对语料）、shuorenhua、slop-score 等。其中配对语料的结论很关键：黑名单词、“首先/其次”、句长参差在内容对齐后人和 AI 没有区别，**机械地全量替换只会制造另一种刻意**；真正强的信号是“不是A而是B”、结论提示冒号、句尾“，彰显了……”、顿号罗列、相邻句同构、小标题过多。

所以这里的原则是：

- **只处理扎堆的地方**。词表类命中（赋能、提升、显著……）单次正常使用只做虚线提示，超出密度预算或扎堆才交给模型；自动清理只删空壳（“值得注意的是”、助手腔、加粗、emoji），从不做同义词替换。
- **改过头也算失败**。改写后出现同义轮换（提升/增强/改善轮着用）、表演型口语（咱们、说白了）、虚构情节，都会被打回。
- **事实锁**。数字、日期、专名、英文缩写、文件名、链接、引号内容进入台账，改写后逐项核对；凭空出现的新数字直接判失败；“可能/疑似”被改成确定语气会提示。
- **原文已经自然就不改**（AI 味 < 15 时只做确定性清理，不调用模型）。

## 流水线

```
检测（规则 + 统计，0-100 可解释分数）
 → 事实台账
 → 确定性清理（只删空壳）
 → 长文按段落分块并行
 → 多模型候选（不同家族模型各出一稿）
 → 本地校验：事实 / 篇幅 / 残留强信号 / 同义轮换 / 改动过少（只换词）/ 照搬风格样本
 → 可选：审校模型做语义等价核对
 → 修复循环：事实类严重问题从原文重写，轻微问题在上一版上定点修；调用失败自动换下一个模型
 → 择优
```

三档改动幅度：

| 档位 | 做法 |
|---|---|
| 小改 | 模型只返回要改的片段（find/replace），每处修改单独过事实守卫，其余文字一字不动；通常几秒 |
| 中改 | 重排句子和节奏，段落结构不变 |
| 重写 | 只保留事实重新组织；与原文过于相似（编辑相似度 > 0.72、最长照抄 > 36 字）判为“只换词” |

每次完成后界面会显示实际改动比例。

场景：通用、任务说明/题面、学术、商务/公文、日常、自媒体。可以提供人写风格样本，服务只提取抽象特征（句长、逗号/句号比、段落形态、人称、开头方式），不把样本原文交给模型，并检查成稿是否照搬样本（共享 ≥ 18 字判失败）。

## 供应商

后台可配置任意多个，改写、审校分别选模型：

- **OpenAI 兼容**：OpenAI、DeepSeek、通义、Kimi、智谱、OpenRouter、各类中转网关、本地 Ollama/vLLM
- **Anthropic**（官方 SDK，官方地址下默认开启拒答兜底）
- **Gemini 原生**
- **离线演示**：不需要密钥，用规则改写跑通全流程

密钥可以直接存在服务端，也可以引用环境变量（变量名必须以 `_KEY` 结尾）。接口返回时一律脱敏。

实测（2026-10，经 OpenAI 兼容中转网关）：改写用 `gemini-4-argon`、审校用 `qwen3.8-max` 效果最好。中改单篇约 1.5–2.5 分钟（几乎全是模型本身的耗时），小改约 10 秒。`gemini-3.1-pro-preview` 已在该网关下线。

## 接入药大拾间

配置 `CPUTIME_SECRET`（与主站 `NOAI_INTEGRATION_SECRET` 相同，至少 32 位）和 `PUBLIC_URL` 后：

- **登录**：用药大拾间账号登录（OAuth 授权码 + PKCE，与拾间支付相同；拿到身份后立即吊销主站 token，本地只保留自己的会话 cookie）。主站管理员自动成为后台管理员。`ACCESS_MODE=cpu` 时改写必须登录，检测不用。
- **模型**：自动加入「药大拾间 AI」供应商，走主站后台「拾间 AI 对话」线路，模型在主站后台统一配置。
- **额度**：每次改写按篇幅扣拾间 AI 额度（每 3000 字 1 次，最多 8 次；日额度用完扣点数）。原文不像 AI、没调用模型的不扣；模型一次都没成功则退回。

## 运行

需要 Node 23.6+（直接运行 TypeScript，无构建步骤）。

```bash
npm install
npm start
```

首次启动会打印管理员令牌（或用 `ADMIN_TOKEN` 指定）。打开 `/admin` 配置供应商和模型，`/` 是前台。

```bash
npm test
```

### Docker 部署

```bash
cp .env.example .env   # 填 ADMIN_TOKEN 等
docker compose up -d --build
```

容器只监听本机 3001，用 nginx/Caddy 做 HTTPS 反代。SSE 需要关闭代理缓冲（服务已返回 `X-Accel-Buffering: no`），nginx 示例：

```nginx
location / {
  proxy_pass http://127.0.0.1:3001;
  proxy_http_version 1.1;
  proxy_buffering off;
  proxy_read_timeout 600s;
  proxy_set_header X-Forwarded-For $remote_addr;
}
```

### 宝塔 / 普通 Linux 服务器

```bash
bash deploy/install.sh /path/to/no-ai-<sha>.tar.gz
```

脚本会校验发布包、在 `/opt/no-ai/node` 装独立 Node、首次生成 `/opt/no-ai/.env` 和管理员令牌、建 `no-ai.service`（只监听 127.0.0.1:23360），重复运行即升级。然后在宝塔里建站点并反向代理到 `http://127.0.0.1:23360`，代理配置里加 `proxy_read_timeout 600s; proxy_buffering off;`。

### 主要环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `ACCESS_MODE` | `key` | `cpu` 用药大拾间账号登录；`key` 需要访问密钥；`open` 任何人可用，按 IP 限额 |
| `ADMIN_TOKEN` | 自动生成 | 管理员令牌，库里只存哈希 |
| `ALLOW_BYO` | `0` | 允许请求自带 API Key（只允许 https 公网地址） |
| `MAX_INPUT_CHARS` | 20000 | 单次字数上限 |
| `RATE_PER_MIN` | 20 | 每个密钥/IP 每分钟请求数 |
| `OPEN_DAILY_CHARS` | 20000 | open 模式下每个 IP 每日字数 |
| `MAX_CONCURRENT` / `MAX_QUEUE` | 4 / 20 | 并发与排队上限 |
| `STORE_RESULTS_HOURS` | 0 | 保存改写正文的小时数，0 只留统计 |
| `CPUTIME_SECRET` | 空 | 药大拾间集成密钥；为空时不启用登录与主站 AI |
| `PUBLIC_URL` | 空 | 对外地址，如 `https://noai.cputime.cn`，用于登录回调 |
| `CPUTIME_ORIGIN` | `https://cputime.cn` | 主站地址 |
| `USER_DAILY_CHARS` | 0 | 登录用户在 No-AI 侧的每日字数上限（0 不限，以拾间 AI 额度为准） |
| `TRUST_PROXY` | `0` | 反代后面设为 1，按 X-Real-IP（或 X-Forwarded-For 最后一段）识别 IP |

## API

所有请求带 `Authorization: Bearer <访问密钥>`（open 模式可省略）。

```http
POST /api/detect   {"text": "..."}                       → 分数、命中位置、统计
POST /api/rewrite  {"text": "...", "options": {...}}      → 结果（含 text 字段，兼容旧版客户端）
POST /api/rewrite?stream=1                                → SSE：stage/detect/ledger/cleanup/candidate/done
POST /api/batch    {"items": ["...", "..."], "options": {...}} → 每篇结果 + 跨篇模板化检查
GET  /api/meta
```

`options`：`mode`、`strength`（light/medium/deep）、`lang`、`protect`（必须保留的词）、`styleSamples`、`instructions`、`keepStructure`、`semanticCheck`、`models`（选用哪些已配置的改写模型）、`skipIfClean`。

旧版 `{text, apiKey, baseUrl, model}` 请求在 `ALLOW_BYO=1` 时仍可用，但不建议在公网上明文传密钥。

## 说明

AI 味指数衡量的是读者能感到的模型腔调，不是任何检测平台的判定结果，服务也不针对任何检测器做规避。请只处理你有权修改的文字。
