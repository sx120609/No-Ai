// AI 味模式库。来源：出题流水线的返修经验、Wikipedia「Signs of AI writing」、
// 中文社区整理的去 AI 味清单，以及开源 humanizer / anti-slop 项目的词表。
//
// severity：1 轻（单次出现无妨，堆积才明显）/ 2 中 / 3 重（几乎只在模型输出里出现）
// cleanup：确定性、不改事实的替换；返回 null 表示不能安全自动处理，只交给模型改写。

import type { Lang, Severity } from '../types.ts';

export interface PatternDef {
  id: string;
  lang: Lang;
  category: string;
  label: string;
  re: RegExp;
  severity: Severity;
  advice: string;
  cleanup?: (m: RegExpMatchArray) => string | null;
  /** 单独出现不算证据，聚集才计分（humanizer 的 weak-alone 规则） */
  weak?: boolean;
  /** 属于“表达不清”而非“AI 证据”：照样提示，但计分打折（avoid-ai-writing 的 1B 层） */
  clarity?: boolean;
}

const drop = () => '';
const keepGroup = (i: number) => (m: RegExpMatchArray) => m[i] ?? '';

// 拼接词表，统一加全局标志
const words = (list: string[]) => new RegExp(`(?:${list.join('|')})`, 'g');

export const CATEGORIES: Record<string, string> = {
  filler: '套话填充',
  template: '模板句式',
  buzz: '空洞大词',
  inflate: '拔高升华',
  hedge: '对冲限定',
  assistant: '助手腔',
  structure: '版式痕迹',
  punct: '标点习惯',
  rhythm: '节奏整齐',
  metaphor: '滥用修辞',
  nominal: '名词化',
  overdone: '矫枉过正',
};

export const ZH_PATTERNS: PatternDef[] = [
  // ---- 套话填充 ----
  {
    id: 'zh.filler.notably', lang: 'zh', category: 'filler', label: '值得注意的是/需要指出的是', severity: 3,
    re: /(?:值得(?:注意|一提|关注|强调)的是|需要(?:注意|指出|强调|说明)的是|必须(?:指出|强调)的是|不可忽视的是|不难(?:发现|看出))[，,：:]?/g,
    advice: '删掉提示语，直接说事；真要强调，用具体后果说明为什么重要。', cleanup: drop,
  },
  {
    id: 'zh.filler.summary', lang: 'zh', category: 'filler', label: '总而言之/综上所述', severity: 3,
    re: /(?:总而言之|综上所述|总的来说|总体而言|总之|概括来说|简而言之|一言以蔽之)[，,：:]/g,
    advice: '去掉总结提示语；结尾如果只是重复前文，整句删掉。', cleanup: drop,
  },
  {
    id: 'zh.filler.era', lang: 'zh', category: 'filler', label: '在当今……时代/随着……的发展', severity: 3,
    re: /(?:在当今(?:这个)?[^，。]{0,12}(?:时代|社会|世界)|随着[^，。]{1,20}的(?:不断|快速|飞速|日益|迅猛)?(?:发展|进步|普及|深入)|在[^，。]{1,16}的(?:大)?背景下)[，,]?/g,
    advice: '删掉宏大背景铺垫，从具体的人、事、数据开头。',
  },
  {
    id: 'zh.filler.known', lang: 'zh', category: 'filler', label: '众所周知/毋庸置疑', severity: 2,
    re: /(?:众所周知|毋庸置疑|不言而喻|显而易见|可以说|可以看出|由此可见|事实上|实际上)[，,]?/g,
    advice: '这类断言铺垫堆在一起才是问题，删掉多余的，正常用的保留。',
    weak: true,
  },
  {
    id: 'zh.filler.dimension', lang: 'zh', category: 'filler', label: '从……角度来看/在……方面', severity: 1,
    weak: true,
    re: /从[^，。]{1,10}(?:的)?(?:角度|层面|维度)(?:来看|来说|出发|而言)[，,]?/g,
    advice: '换成直接陈述，或者说清楚是谁、在什么情况下。',
  },

  // ---- 模板句式 ----
  {
    id: 'zh.tpl.not-but', lang: 'zh', category: 'template', label: '不是……而是……', severity: 3,
    re: /(?:这)?(?:并)?不(?:仅仅|只|单单)?是[^。！？\n]{1,30}[，,]\s*而是/g,
    advice: '“不是A而是B”是最典型的模型句式。直接说B，或者用具体事实对比。',
  },
  {
    id: 'zh.tpl.not-only', lang: 'zh', category: 'template', label: '不仅……更/还……', severity: 2,
    weak: true,
    re: /不仅(?:仅)?[^。！？\n]{1,30}[，,]\s*(?:更|还|也|而且)(?:是|能|会|要)?/g,
    advice: '递进句式出现多次时，拆成两句平铺直叙。',
  },
  {
    id: 'zh.tpl.rather', lang: 'zh', category: 'template', label: '与其说……不如说……', severity: 3,
    re: /与其说[^。！？\n]{1,30}[，,]?\s*不如说/g,
    advice: '直接给出判断。',
  },
  {
    id: 'zh.tpl.not-in', lang: 'zh', category: 'template', label: '问题不在于……而在于', severity: 3,
    re: /(?:问题|关键|重点)?不在于[^。！？\n]{1,30}[，,]?\s*而(?:在于|是)/g,
    advice: '二分对照壳，直接说真正的原因。',
  },
  {
    id: 'zh.tpl.essence', lang: 'zh', category: 'template', label: '本质上/核心在于/真正……的是', severity: 3,
    re: /本质上|核心在于|关键在于|归根结底|说到底|真正(?:重要|关键|决定|需要|要看|的问题)的?是/g,
    advice: '“本质拔高”句式，删掉拔高语，直接陈述判断依据。',
  },
  {
    id: 'zh.tpl.signpost', lang: 'zh', category: 'template', label: '下面我们来/接下来我会', severity: 3,
    re: /(?:下面|接下来)(?:我们|我)(?:来|将|会)|我们可以看到|让我们来看/g,
    advice: '删掉讲解路标。', cleanup: drop,
  },
  {
    id: 'zh.tpl.fake-interact', lang: 'zh', category: 'assistant', label: '假互动', severity: 2,
    re: /你觉得呢[？?]?|欢迎(?:在评论区)?(?:留言|讨论|交流)[^。！\n]*[。！]?/g,
    advice: '删掉假互动。', cleanup: drop,
  },
  {
    id: 'zh.tpl.both', lang: 'zh', category: 'template', label: '既……又……/一方面……另一方面', severity: 1,
    weak: true,
    re: /一方面[^。！？\n]{1,40}另一方面|既[^。！？\n]{1,15}[，,]?又/g,
    advice: '对称结构太工整，改成主次分明的一句或两句。',
  },
  {
    id: 'zh.tpl.ordinal', lang: 'zh', category: 'template', label: '首先……其次……最后', severity: 2,
    weak: true,
    re: /(?:首先|第一)[，,][\s\S]{1,200}?(?:其次|第二)[，,][\s\S]{1,200}?(?:最后|再次|第三)[，,]/g,
    advice: '去掉序数词串联，按事情的因果或时间顺序自然衔接。',
  },
  {
    id: 'zh.tpl.this-is', lang: 'zh', category: 'template', label: '这正是……所在/这意味着', severity: 2,
    re: /这(?:正|恰恰|也)?(?:是|就是)[^。！？\n]{1,16}(?:所在|的关键|的意义|的核心)|这(?:意味着|表明|说明|体现了|反映了)/g,
    advice: '少用“这意味着/这体现了”做转述，直接说后果。',
  },
  {
    id: 'zh.tpl.through', lang: 'zh', category: 'template', label: '通过……实现/有效……', severity: 1,
    weak: true,
    re: /通过[^。！？\n]{1,24}[，,]?\s*(?:实现|达到|达成|有效)(?:了)?/g,
    advice: '“通过X实现Y”改成“做了X，所以Y”这类具体动作链。',
  },
  {
    id: 'zh.tpl.zhe-yi', lang: 'zh', category: 'template', label: '这一（这一过程/这一点）', severity: 1,
    weak: true,
    re: /这一(?:过程|点|现象|问题|趋势|做法|举措|变化|理念|目标|领域|环节|阶段)/g,
    advice: '“这一X”是翻译腔，改成“这个”“这”或直接点名。',
  },

  // ---- 空洞大词 ----
  {
    id: 'zh.buzz.jargon', lang: 'zh', category: 'buzz', label: '互联网黑话', severity: 2,
    clarity: true,
    re: words(['赋能', '抓手', '闭环', '打通', '底层逻辑', '颗粒度', '顶层设计', '链路', '心智', '对齐', '沉淀', '组合拳', '护城河', '飞轮', '矩阵', '一站式', '全链路', '全方位', '多维度', '深度融合', '无缝衔接', '降本增效', '提质增效']),
    advice: '把黑话换成大白话：说清楚具体做什么、谁来做。',
  },
  {
    id: 'zh.buzz.process', lang: 'zh', category: 'buzz', label: '流程黑话', severity: 2,
    clarity: true,
    re: words(['系统梳理', '结构化串联', '有效落地', '全面核对', '准确无误', '核心字段', '前置环节', '直接穿透', '数据断层', '协作负担', '整体推进', '高置信度', '深度洞察', '价值沉淀', '深耕', '打造', '亮眼成绩', '蓬勃发展', '兜底']),
    advice: '流程黑话改成具体动作和对象。',
  },
  {
    id: 'zh.buzz.grand', lang: 'zh', category: 'buzz', label: '宏大形容', severity: 2,
    re: words(['至关重要', '不可或缺', '举足轻重', '重中之重', '意义深远', '深远影响', '重要意义', '关键作用', '核心价值', '坚实基础', '有力保障', '强大动力', '重要支撑', '必不可少', '日益凸显', '愈发重要', '前所未有', '里程碑']),
    advice: '去掉评价性大词，用一个具体例子或数字说明重要在哪。',
  },
  {
    id: 'zh.buzz.verbs', lang: 'zh', category: 'buzz', label: '空泛动词', severity: 1,
    clarity: true,
    re: words(['助力', '引领', '推动', '促进', '提升', '优化', '深化', '强化', '聚焦', '致力于', '旨在', '着眼于', '持续优化', '不断完善', '全面提升', '深入探讨', '深入了解', '充分发挥', '积极探索', '稳步推进']),
    advice: '换成具体动作（改了什么、删了什么、算了什么）。',
  },
  {
    id: 'zh.buzz.adj', lang: 'zh', category: 'buzz', label: '万能形容词', severity: 1,
    clarity: true,
    re: words(['高效', '显著', '卓越', '独特', '丰富多彩', '多元化', '个性化', '智能化', '精准', '全面', '系统性', '前瞻性', '创新性']),
    advice: '形容词要么删掉，要么换成可验证的描述。',
  },

  {
    id: 'zh.tpl.flip', lang: 'zh', category: 'template', label: '看似……实则/你以为……其实', severity: 3,
    re: /看似[^。！？\n]{1,20}[，,]?\s*(?:实则|其实|实际上)|你以为[^。！？\n]{1,30}[，,]?\s*其实|(?:不|并不)(?:重要|关键)[，,]\s*(?:真正)?(?:重要|关键)的是/g,
    advice: '翻案句式，直接陈述结论。',
  },
  {
    id: 'zh.tpl.reveal-colon', lang: 'zh', category: 'template', label: '结论提示冒号', severity: 3,
    re: /(?:一句话总结|一句话概括|核心(?:是|在于)|关键(?:是|在于)|本质上?是|原因(?:如下|很简单)|真相是|答案是|结论是|简单来说|说白了|先说结论)[：:]/g,
    advice: '“关键是：”这类先抛提示再给答案的写法约是人类的两倍，直接写答案。',
  },
  {
    id: 'zh.tpl.strawman', lang: 'zh', category: 'template', label: '与假想敌辩论', severity: 2,
    re: /(?:别|不要)误会|我并不是(?:说|在)|这并不意味着|有人(?:可能)?会(?:说|认为|问)/g,
    advice: '没人这么说过就不用反驳，直接说你的意思。',
  },
  {
    id: 'zh.tpl.topic-shell', lang: 'zh', category: 'template', label: '对于……来说', severity: 1, weak: true,
    re: /(?:^|[。！？\n])\s*(?:对于|就)[^，。\n]{1,15}(?:来说|而言)[，,]/g,
    advice: '前置话题壳是翻译腔，直接让主语出场。',
  },
  {
    id: 'zh.tpl.role', lang: 'zh', category: 'template', label: '扮演着……角色/发挥着……作用', severity: 2,
    re: /扮演(?:着)?[^。，]{0,8}角色|发挥(?:着)?[^。，]{0,8}作用/g,
    advice: '回避“是/有”的绕写，直接说它做了什么。',
  },
  {
    id: 'zh.tpl.range', lang: 'zh', category: 'template', label: '从A到B再到C', severity: 2,
    re: /从[^，。\n]{1,12}到[^，。\n]{1,12}[，,]?\s*(?:再到|乃至)/g,
    advice: '伪范围列举，挑一个具体的说。',
  },
  {
    id: 'zh.tpl.attribution', lang: 'zh', category: 'filler', label: '模糊归因', severity: 2,
    re: /(?:相关|大量|多项)?(?:研究|调查|专家|学者|业内人士)(?:表明|显示|认为|指出)/g,
    advice: '没有具体出处时，要么由作者补出处，要么删掉归因，不要编造来源。',
  },

  // ---- 拔高升华 ----
  {
    id: 'zh.inflate.tail', lang: 'zh', category: 'inflate', label: '句尾拔高（，彰显了……）', severity: 3,
    re: /[，,]\s*(?:充分|深刻|有力)?(?:彰显|体现|展现|凸显|折射|诠释)(?:了|出)[^。！？\n]{2,25}[。！]/g,
    advice: '句尾用“彰显了/体现了”拔高是强信号，删掉这半句。',
  },
  {
    id: 'zh.inflate.milestone', lang: 'zh', category: 'inflate', label: '意义拔高', severity: 2,
    re: /标志着|开启了[^。]{0,6}(?:新篇章|新时代|新纪元)|具有(?:重要|深远|里程碑|划时代)的?(?:意义|影响)|历史性|决定性|划时代/g,
    advice: '去掉意义宣告，交给读者判断。',
  },
  {
    id: 'zh.inflate.promo', lang: 'zh', category: 'inflate', label: '宣传腔', severity: 1, clarity: true,
    re: /极致|颠覆(?:性)?|革命性|令人(?:惊叹|震撼)|无与伦比|堪称|叹为观止/g,
    advice: '宣传腔形容词换成事实。',
  },
  {
    id: 'zh.inflate.essence', lang: 'zh', category: 'inflate', label: '伪深度', severity: 2,
    re: /是[^，。\n]{1,6}的(?:底色|灵魂|注脚|底气|密码)|归根到底/g,
    advice: '格言式伪深度，删掉或换成具体说法。',
  },
  {
    id: 'zh.inflate.ending', lang: 'zh', category: 'inflate', label: '结尾升华', severity: 3,
    re: /(?:让我们(?:一起|共同)?|未来可期|值得我们(?:深思|期待|思考)|开启[^。！？\n]{0,10}新篇章|迈向[^。！？\n]{0,10}新(?:阶段|高度|征程)|注入(?:新的)?(?:活力|动力)|书写[^。！？\n]{0,10}篇章|贡献(?:一份)?力量)/g,
    advice: '删掉喊口号式结尾，停在最后一个具体信息上。',
  },
  {
    id: 'zh.inflate.both', lang: 'zh', category: 'inflate', label: '……的同时，也……', severity: 1,
    weak: true,
    re: /的同时[，,]\s*(?:也|还|更)/g,
    advice: '拆成两句，或保留更重要的那半句。',
  },

  // ---- 对冲限定 ----
  {
    id: 'zh.hedge', lang: 'zh', category: 'hedge', label: '模糊限定', severity: 1,
    weak: true,
    re: words(['在一定程度上', '某种程度上', '一定程度上', '在很大程度上', '相对而言', '通常来说', '一般来说', '往往会', '可能会在']),
    advice: '要么给出确定判断，要么说明不确定的具体原因。',
  },

  // ---- 助手腔 ----
  {
    id: 'zh.assistant.opener', lang: 'zh', category: 'assistant', label: '好的/当然/以下是', severity: 3,
    re: /^(?:好的|当然(?:可以)?|没问题|非常好的问题|这是一个(?:很|非常)?好的问题)[！!，,。.]?\s*(?:以下是[^\n：:]*[：:])?\s*/gm,
    advice: '删掉应答开场白。', cleanup: drop,
  },
  {
    id: 'zh.assistant.following', lang: 'zh', category: 'assistant', label: '以下是……：', severity: 2,
    re: /^(?:以下是|下面是|下面(?:我)?(?:将|来)(?:为你|为您)?(?:详细)?(?:介绍|说明|分析))[^\n]{0,30}[：:]\s*$/gm,
    advice: '删掉“以下是”引导行。', cleanup: drop,
  },
  {
    id: 'zh.assistant.closing', lang: 'zh', category: 'assistant', label: '希望对你有帮助', severity: 3,
    re: /(?:希望(?:以上|这些|本文)?(?:内容|信息|回答|建议)?(?:能)?(?:对(?:你|您)(?:有所)?帮助|有所帮助)|如果(?:你|您)(?:还)?有(?:其他|任何|更多)(?:问题|疑问|需要)[^。！\n]*)[。！!]?/g,
    advice: '删掉客服式结尾。', cleanup: drop,
  },
  {
    id: 'zh.assistant.residue', lang: 'zh', category: 'assistant', label: '聊天残留', severity: 3,
    re: /截至我的(?:知识|训练)[^。\n]*[。]?|如果(?:你|您)愿意[，,]?\s*我可以[^。\n]*[。]?|如需[^。\n]{0,12}请随时[^。\n]*[。]?|好问题[！!。]?/g,
    advice: '删除聊天工具残留。', cleanup: drop,
  },
  {
    id: 'zh.assistant.self', lang: 'zh', category: 'assistant', label: 'AI 自指', severity: 3,
    re: /作为(?:一个|一名)?(?:AI|人工智能|语言模型|AI助手)[^，。]*[，,]?/g,
    advice: '删除 AI 自指。', cleanup: drop,
  },

  // ---- 版式痕迹 ----
  {
    id: 'zh.struct.bold', lang: 'zh', category: 'structure', label: 'Markdown 加粗', severity: 2,
    re: /\*\*([^*\n]{1,60})\*\*/g,
    advice: '正文不用加粗。', cleanup: keepGroup(1),
  },
  {
    id: 'zh.struct.bold-lead', lang: 'zh', category: 'structure', label: '加粗小标题+冒号', severity: 3,
    re: /^\s*(?:[-*•]\s*)?\*\*[^*\n]{1,20}\*\*[：:]/gm,
    advice: '“**要点**：说明”是典型模型排版，改成自然段落。',
  },
  {
    id: 'zh.struct.emoji', lang: 'zh', category: 'structure', label: 'Emoji 点缀', severity: 2,
    re: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2705}\u{274C}]️?/gu,
    advice: '去掉 emoji。', cleanup: drop,
  },
  {
    id: 'zh.struct.heading', lang: 'zh', category: 'structure', label: 'Markdown 标题', severity: 1,
    re: /^\s*#{1,6}\s+/gm,
    advice: '短文不需要分级标题。',
  },

  // ---- 标点习惯 ----
  {
    id: 'zh.punct.dash', lang: 'zh', category: 'punct', label: '破折号', severity: 2,
    re: /——/g,
    advice: '中文模型极爱用破折号做补充说明，改成逗号、句号或括号，或重组句子。',
  },
  {
    id: 'zh.punct.semicolon', lang: 'zh', category: 'punct', label: '分号', severity: 1,
    weak: true,
    re: /；/g,
    advice: '中文日常写作很少用分号串联，拆成句号或用逗号承接；不要机械替换成逗号。',
  },
  {
    id: 'zh.punct.cjk-space', lang: 'zh', category: 'punct', label: '中英文间加空格', severity: 2,
    re: /(?<=[一-鿿])[ \t]+(?=[A-Za-z0-9])|(?<=[A-Za-z0-9%])[ \t]+(?=[一-鿿])/g,
    advice: '模型习惯在汉字与英文/数字之间加空格，中文作者一般不加。', cleanup: drop,
  },
  {
    id: 'zh.punct.colon-reveal', lang: 'zh', category: 'punct', label: '冒号揭晓', severity: 1,
    re: /(?:答案|原因|关键|核心|秘诀|结果|真相|问题)(?:很简单|在于|就是)?[：:]/g,
    advice: '去掉设问揭晓式冒号，直接陈述。',
  },
  {
    id: 'zh.punct.quote-emph', lang: 'zh', category: 'punct', label: '引号强调', severity: 1,
    re: /所谓的?[“"][^”"]{1,12}[”"]/g,
    advice: '少用引号造概念。',
  },

  {
    id: 'zh.punct.dunhao', lang: 'zh', category: 'rhythm', label: '顿号罗列', severity: 1, weak: true,
    re: /[^，。！？；\n、]{1,10}(?:、[^，。！？；\n、]{1,10}){3,}/g,
    advice: '一句里并列四项以上，挑重要的说，其余归类或删去；不要把顿号机械换成逗号。',
  },
  {
    id: 'zh.rhythm.four-char', lang: 'zh', category: 'rhythm', label: '四字词排比', severity: 2,
    re: /(?:[一-鿿]{4}[、，,]){2,}[一-鿿]{4}(?=[。，,！；]|$)/g,
    advice: '四字格连排像宣传稿，拆开或换成具体描述。',
  },

  // ---- 滥用修辞 ----
  {
    id: 'zh.meta.webnovel', lang: 'zh', category: 'metaphor', label: '网文 AI 腔', severity: 2,
    re: /淬了(?:毒|冰)|不容置喙|像[^。，]{1,8}的刀|眼神里有[^，。]{1,8}[，,]\s*但更多的是|心潮澎湃|空气(?:仿佛)?凝固/g,
    advice: '网文模型腔，换成具体动作或删去。',
  },
  {
    id: 'zh.meta', lang: 'zh', category: 'metaphor', label: '空洞比喻', severity: 2,
    re: /(?:宛如|犹如|仿佛|如同)[^，。]{0,10}(?:交响曲|画卷|灯塔|桥梁|基石|钥匙|引擎|催化剂|明灯)|(?:织就|绘就|谱写|奏响)[^，。]{0,8}/g,
    advice: '删掉装饰性比喻。',
  },

  // ---- 说教与指令堆叠 ----
  {
    id: 'zh.preach.dont', lang: 'zh', category: 'hedge', label: '说教式边界', severity: 2,
    clarity: true,
    re: /(?:请勿|请不要|切勿|务必|严禁)|(?:不要|不能|不得)(?:把|将|用|据此|自行|直接|擅自|随意|凭空|编造|外推)/g,
    advice: '“不要把X…”改成正向安排，比如“X 先列为待核”。',
  },

  // ---- 矫枉过正（改写后才常见） ----
  {
    id: 'zh.over.colloquial', lang: 'zh', category: 'overdone', label: '表演型口语', severity: 2,
    re: words(['咱们', '我这边', '说死', '谁也不敢', '靠猜', '说白了', '讲真', '整挺好', '老板催', '挺急的', '你懂的', '一句话']),
    advice: '不要用刻意口语或虚构情绪来装“像人”，保持清楚克制。',
  },
  {
    id: 'zh.over.upload', lang: 'zh', category: 'overdone', label: '上传元话语', severity: 2,
    re: /(?:我)?(?:刚|刚刚)?(?:传了|上传了|发了)(?:几份|一份|两份|这些)?(?:材料|附件|文件)|随本消息(?:上传|附上)/g,
    advice: '不必交代“我上传了”，直接说材料里有什么。',
  },

  // ---- 名词化 ----
  {
    id: 'zh.nominal.jinxing', lang: 'zh', category: 'nominal', label: '进行+动词', severity: 1,
    clarity: true,
    re: /(?:进行|加以|予以)(?:了)?([一-鿿]{2})/g,
    advice: '“进行分析”直接写“分析”；公文和学术文体里可以保留。',
  },
];

export const EN_PATTERNS: PatternDef[] = [
  {
    id: 'en.filler.notably', lang: 'en', category: 'filler', label: '"It\'s worth noting"', severity: 3,
    re: /\b(?:it(?:'s| is) (?:worth noting|important to note|crucial to (?:note|remember|understand)|essential to (?:note|remember))|it should be noted)(?: that)?,?\s*/gi,
    advice: 'Delete the signpost and state the point.', cleanup: drop,
  },
  {
    id: 'en.filler.era', lang: 'en', category: 'filler', label: '"In today\'s fast-paced world"', severity: 3,
    re: /\b(?:in today's (?:fast-paced|ever-changing|digital|modern|rapidly evolving) (?:world|landscape|age|era)|in the (?:ever-evolving|rapidly changing|digital) (?:world|landscape|age)|in an era (?:of|where))[^,.]*,?/gi,
    advice: 'Cut the scene-setting; open with something concrete.',
  },
  {
    id: 'en.filler.summary', lang: 'en', category: 'filler', label: '"In conclusion / Overall"', severity: 2,
    re: /(?:^|(?<=[.!?]\s))(?:in conclusion|in summary|to sum up|overall|ultimately|all in all),\s*/gim,
    advice: 'Drop summary signposts; end on the last real point.', cleanup: drop,
  },
  {
    id: 'en.tpl.not-just', lang: 'en', category: 'template', label: '"not just X, but Y"', severity: 3,
    re: /\b(?:(?:it'?s|this is|is|was|are) )?not (?:just|only|merely|simply) [^.;!?]{1,60}?[,;—–-]\s*(?:but|it'?s)\b/gi,
    advice: 'The "not X but Y" contrast is a top tell; say Y directly.',
  },
  {
    id: 'en.tpl.serves-as', lang: 'en', category: 'template', label: '"serves as / stands as"', severity: 2,
    re: /\b(?:serves|stands|acts) as (?:a |an )?(?:testament|reminder|beacon|cornerstone|catalyst|bridge|foundation)\b/gi,
    advice: 'Replace with a plain verb ("is", "shows") or cut.',
  },
  {
    id: 'en.tpl.plays-role', lang: 'en', category: 'template', label: '"plays a vital role"', severity: 2,
    re: /\bplays? an? (?:vital|crucial|pivotal|key|significant|important|critical) role\b/gi,
    advice: 'Say what it actually does.',
  },
  {
    id: 'en.tpl.ing-tail', lang: 'en', category: 'inflate', label: 'Participle tail (", highlighting…")', severity: 3,
    re: /,\s(?:highlighting|underscoring|emphasizing|reflecting|showcasing|fostering|cementing|solidifying|contributing to|marking)\b[^.!?]*[.!?]/gi,
    advice: 'Cut the participle tail that inflates significance.',
  },
  {
    id: 'en.tpl.isnt-about', lang: 'en', category: 'template', label: '"It isn\'t about X. It\'s Y"', severity: 3,
    re: /\bisn'?t (?:about|just)\b[^.]{1,50}\.\s+It'?s\b/gi,
    advice: 'Say Y directly.',
  },
  {
    id: 'en.tpl.strawman', lang: 'en', category: 'template', label: 'Arguing with nobody', severity: 2,
    re: /\b(?:to be clear|don't get me wrong|i'm not saying|this is not to say|make no mistake)\b/gi,
    advice: 'Drop the defensive framing.',
  },
  {
    id: 'en.tpl.depth', lang: 'en', category: 'template', label: 'Faux depth', severity: 2,
    re: /\b(?:at its core|the real question is|what really matters|at the end of the day|let that sink in|read that again)\b/gi,
    advice: 'Replace with the actual point.',
  },
  {
    id: 'en.tpl.selfref', lang: 'en', category: 'assistant', label: 'Document self-reference', severity: 2,
    re: /\b(?:this (?:section|article|post|guide) (?:explores|will|covers|delves)|in this (?:guide|article), we|let's (?:dive|explore|break (?:this|it) down)|without further ado)\b/gi,
    advice: 'Start with the content, not a description of it.',
  },
  {
    id: 'en.residue', lang: 'en', category: 'assistant', label: 'Chat-tool residue', severity: 3,
    re: /utm_source=chatgpt\.com|oaicite:?\d*|contentReference\[[^\]]*\]|\bas of my last (?:update|training)[^.]*\.?/gi,
    advice: 'Remove tool residue.', cleanup: drop,
  },
  {
    id: 'en.attrib', lang: 'en', category: 'filler', label: 'Vague attribution', severity: 2,
    re: /\b(?:experts|observers|studies|research|critics) (?:argue|note|suggest|show|say)\b/gi,
    advice: 'Name the source (author-provided) or drop the attribution; never invent one.',
  },
  {
    id: 'en.adverb', lang: 'en', category: 'buzz', label: 'Magic adverbs', severity: 1, weak: true,
    re: /\b(?:quietly|deeply|fundamentally|remarkably|truly|genuinely|incredibly)\b/gi,
    advice: 'Usually removable.',
  },
  {
    id: 'en.buzz.vocab', lang: 'en', category: 'buzz', label: 'LLM vocabulary', severity: 2,
    re: /\b(?:delve[sd]?|delving|tapestry|testament|pivotal|intricate|intricacies|multifaceted|meticulous(?:ly)?|commendable|paramount|showcas(?:e|es|ed|ing)|underscor(?:e|es|ed|ing)|foster(?:s|ed|ing)?|bolster(?:s|ed|ing)?|garner(?:s|ed|ing)?|realm|landscape|seamless(?:ly)?|robust|leverag(?:e|es|ed|ing)|holistic|synerg(?:y|ies)|ever-evolving|game-chang(?:er|ing)|cutting-edge|unlock(?:s|ed|ing)?|elevat(?:e|es|ed|ing)|embark(?:s|ed|ing)?|navigat(?:e|es|ing) the|vibrant|bustling|nestled|enduring|groundbreaking|transformative|unwavering|invaluable)\b/gi,
    advice: 'Swap for plain, specific wording.',
  },
  {
    id: 'en.buzz.important', lang: 'en', category: 'buzz', label: 'Importance inflation', severity: 1,
    clarity: true,
    re: /\b(?:crucial|vital|essential|significant(?:ly)?|key|critical|comprehensive|nuanced|profound)\b/gi,
    advice: 'Show importance with a consequence instead of an adjective.',
  },
  {
    id: 'en.connector', lang: 'en', category: 'rhythm', label: 'Stacked connectors', severity: 1,
    weak: true,
    re: /(?:^|(?<=[.!?]\s))(?:moreover|furthermore|additionally|consequently|notably|importantly|that said|however),\s*/gim,
    advice: 'Most transitions can go; let sentences follow each other.',
  },
  {
    id: 'en.inflate.ending', lang: 'en', category: 'inflate', label: 'Uplifting wrap-up', severity: 3,
    re: /\b(?:the future (?:is|looks) bright|paving the way|a brighter future|stand(?:s)? the test of time|only time will tell|the possibilities are endless|exciting times ahead|continues to (?:shape|inspire|evolve))\b/gi,
    advice: 'End on a specific fact, not a slogan.',
  },
  {
    id: 'en.assistant', lang: 'en', category: 'assistant', label: 'Assistant voice', severity: 3,
    re: /(?:^(?:certainly|absolutely|sure|great question|of course)[!,.]\s*(?:here(?:'s| is| are)[^\n:]*:)?\s*|\bi hope this helps[.!]?|\b(?:let me know|feel free to (?:ask|reach out))[^.!\n]*[.!]?|\bas an ai(?: language model)?,?\s*)/gim,
    advice: 'Remove chatbot framing.', cleanup: drop,
  },
  {
    id: 'en.struct.bold', lang: 'en', category: 'structure', label: 'Markdown bold', severity: 2,
    re: /\*\*([^*\n]{1,60})\*\*/g,
    advice: 'No bold in running prose.', cleanup: keepGroup(1),
  },
  {
    id: 'en.struct.emoji', lang: 'en', category: 'structure', label: 'Emoji', severity: 2,
    re: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2705}\u{274C}]️?/gu,
    advice: 'Remove emoji.', cleanup: drop,
  },
  {
    id: 'en.punct.emdash', lang: 'en', category: 'punct', label: 'Em dash', severity: 2,
    re: /\s?—\s?/g,
    advice: 'Use commas, parentheses or a new sentence instead of em dashes.',
  },
  {
    id: 'en.hedge', lang: 'en', category: 'hedge', label: 'Hedging', severity: 1,
    weak: true,
    re: /\b(?:to some extent|in many ways|arguably|it could be argued|generally speaking|in some cases|may potentially)\b/gi,
    advice: 'Commit to the claim or name the specific uncertainty.',
  },
  {
    id: 'en.metaphor', lang: 'en', category: 'metaphor', label: 'Decorative metaphor', severity: 2,
    re: /\b(?:a (?:rich|vibrant|complex) tapestry|symphony of|a beacon of|the cornerstone of|a melting pot|treasure trove|double-edged sword)\b/gi,
    advice: 'Cut decorative metaphors.',
  },
];

export function patternsFor(lang: Lang): PatternDef[] {
  return lang === 'zh' ? ZH_PATTERNS : EN_PATTERNS;
}
