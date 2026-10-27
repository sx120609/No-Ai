// 全局共享类型。

export type Lang = 'zh' | 'en';

// ---------- 供应商 ----------

export type ProviderType = 'openai' | 'anthropic' | 'gemini' | 'mock';

export interface ProviderConfig {
  id: string;
  name?: string;
  type: ProviderType;
  /** OpenAI 兼容网关填到 /v1 为止；Anthropic/Gemini 留空则用官方地址 */
  baseUrl?: string;
  /** 直接存的密钥（仅服务端可见，接口返回时脱敏） */
  apiKey?: string;
  /** 从环境变量读取密钥，优先级高于 apiKey */
  apiKeyEnv?: string;
  /** 额外请求头，如部分网关需要的 X-Title */
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** 仅 anthropic：官方 API 上开启服务端拒答兜底（fallbacks: "default"） */
  serverFallback?: boolean;
  /** 前端下拉提示用的模型列表 */
  models?: string[];
  enabled?: boolean;
}

export interface ModelBinding {
  provider: string;
  model: string;
  /** 部分模型（如新版 Claude）不接受 temperature，留空即不发送 */
  temperature?: number;
  maxTokens?: number;
  /** low | medium | high | xhigh | max；OpenAI 推理模型与 Claude 都支持 */
  effort?: string;
  /** 该绑定的展示名 */
  label?: string;
}

export type ChatRole = 'system' | 'user' | 'assistant';
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  effort?: string;
  signal?: AbortSignal;
}

export interface ChatResult {
  text: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  latencyMs: number;
  finishReason?: string;
}

export interface LLMClient {
  readonly provider: ProviderConfig;
  chat(req: ChatRequest): Promise<ChatResult>;
}

// ---------- 检测 ----------

export type Severity = 1 | 2 | 3;

export interface PatternHit {
  id: string;
  category: string;
  label: string;
  severity: Severity;
  start: number;
  end: number;
  match: string;
  /** 给改写模型的针对性建议 */
  advice?: string;
  /** 是否需要处理：弱信号/词表类只有扎堆或超出密度预算才需要，单次正常使用不动 */
  actionable: boolean;
  weak?: boolean;
  clarity?: boolean;
}

export interface TextStats {
  chars: number;
  sentences: number;
  paragraphs: number;
  meanSentenceLen: number;
  /** 句长变异系数：人类文本通常更高（长短错落） */
  sentenceLenCV: number;
  /** 段落长度变异系数 */
  paragraphLenCV: number;
  /** 句首重复率：相同开头的句子占比 */
  repeatedOpenerRate: number;
  /** 每千字连接词数 */
  connectorDensity: number;
  /** 每千字破折号/冒号/分号等 */
  dashDensity: number;
  colonDensity: number;
  semicolonDensity: number;
  /** markdown 结构：列表项、加粗、标题 */
  listItems: number;
  boldSpans: number;
  headings: number;
  emoji: number;
  /** 词汇丰富度（type/token） */
  lexicalDiversity: number;
  /** 中文逗号/句号比：人工样本约 2.4，模型稿约 1.3（出题项目语料校准） */
  commaPeriodRatio: number;
  /** 首句长度 */
  firstSentenceLen: number;
}

export interface DetectReport {
  lang: Lang;
  /** 0-100，越高越像 AI */
  score: number;
  level: 'low' | 'medium' | 'high';
  hits: PatternHit[];
  stats: TextStats;
  /** 各分项贡献，便于解释分数 */
  breakdown: { key: string; label: string; points: number; detail?: string }[];
}

// ---------- 事实台账 ----------

export type FactKind = 'number' | 'date' | 'quote' | 'code' | 'latin' | 'url' | 'filename' | 'term' | 'constraint';

export interface Fact {
  kind: FactKind;
  value: string;
  /** 比对时用的规范化值 */
  norm: string;
  /** 是否必须原样保留（数字/代码/引号内容等） */
  strict: boolean;
}

export interface LedgerCheck {
  ok: boolean;
  missing: Fact[];
  /** 改写后凭空出现的数字/实体 */
  added: { kind: FactKind; value: string }[];
  lengthRatio: number;
  paragraphDelta: number;
  problems: string[];
}

// ---------- 流水线 ----------

export type Mode = 'general' | 'task' | 'academic' | 'business' | 'casual' | 'social';
export type Strength = 'light' | 'medium' | 'deep';

export interface RewriteOptions {
  mode?: Mode;
  strength?: Strength;
  lang?: Lang | 'auto';
  /** 必须原样保留的词/短语 */
  protect?: string[];
  /** 用户上传的“人写”范文，用于风格校准 */
  styleSamples?: string[];
  /** 是否保持段落结构 */
  keepStructure?: boolean;
  /** 额外要求 */
  instructions?: string;
  /** 候选数（多模型时每个模型 1 个） */
  candidates?: number;
  /** 未通过时最多修复轮数 */
  maxRepairRounds?: number;
  /** 是否调用 LLM 裁判做语义等价核对 */
  semanticCheck?: boolean;
  /** 指定改写模型（覆盖默认 rewriter 绑定） */
  rewriters?: ModelBinding[];
  /** 原文 AI 味已经很低时只做确定性清理，不调用模型（默认开启） */
  skipIfClean?: boolean;
  /** 超过该长度按段落分块并行处理 */
  chunkChars?: number;
}

export interface Candidate {
  id: string;
  binding: string;
  text: string;
  round: number;
  detect: DetectReport;
  ledger: LedgerCheck;
  semantic?: SemanticVerdict;
  copy?: { edit: number; jaccard: number; longestCopy: number };
  /** 精修模式下实际应用/被拒绝的片段修改 */
  edits?: { find: string; replace: string; rule?: string; applied: boolean; reason?: string }[];
  problems: string[];
  severe: boolean;
  total: number;
  passed: boolean;
  error?: string;
  latencyMs?: number;
}

export interface SemanticVerdict {
  equivalent: boolean;
  score: number;
  issues: string[];
  /** 会改变事实或要求的高严重度问题，只有这些会拦截 */
  blocking: string[];
  aiLikeness?: number;
}

export type PipelineEvent =
  | { type: 'stage'; stage: string; message: string }
  | { type: 'detect'; which: 'before' | 'after'; report: DetectReport }
  | { type: 'cleanup'; text: string; changes: number }
  | { type: 'ledger'; facts: Fact[] }
  | { type: 'candidate'; candidate: Candidate; chunk: number }
  | { type: 'error'; message: string }
  | { type: 'done'; result: RewriteResult };

export interface RewriteResult {
  id: string;
  input: string;
  output: string;
  lang: Lang;
  before: DetectReport;
  after: DetectReport;
  facts: Fact[];
  candidates: Candidate[];
  chosen: string | null;
  passed: boolean;
  /** 原文已足够自然，未调用模型 */
  skipped: boolean;
  chunks: number;
  warnings: string[];
  elapsedMs: number;
  usage: { inputTokens: number; outputTokens: number; calls: number };
}
