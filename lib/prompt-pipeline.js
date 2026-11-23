/**
 * prompt-pipeline.js —— 正文 → 提示词
 *
 * 移植自角色卡 04 号脚本的：
 *   extractAndStripLimeControlTags（4428–4511）  → parseControlTags
 *   resolveSceneTagsViaCustomParser（4391–4411） → parseWithLLM
 *   buildActorDanbooruTags（1646–1667）          → buildPrompt
 *
 * 改动：
 *   · 去掉角色属性系统（好感度 / 欲望值 / 尺度接受度）—— 这里没人格判定，你想画就画
 *   · 去掉「角色固定身份标签总表」的强依赖，改成一个可选的 identity 输入框
 *   · 增加纯离线规则抽取（中文场景词 → danbooru 标签），没配大模型也能用
 *   · 权重语法转换（NAI 那套 {{a|b}} / -1.5::x::）默认关闭：MOSS 用不上
 */

/* ────────── 控制标签 ────────── */

const ATTR_RE = (name) => new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s/>]+))`, 'i');

function readAttr(attrs, name) {
  const m = String(attrs || '').match(ATTR_RE(name));
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3] ?? '').trim();
}

/* ────────── 配图块 ────────── */

/**
 * 一块「配图」= 一个标题 + 一段提示词。
 *
 * 认四种写法，按优先级：
 *   1. <photo title="塞纳河岸的旧书商" kind="scene">自然语言提示词…</photo>
 *      —— 酒馆渲染后只剩一段干净的 <p>，最好处理，世界书里教 AI 用这个
 *   2. <photo>标题｜提示词</photo>          —— 属性里不方便写标题时的简写
 *   3. <image>【标题】image###提示词###</image>
 *      —— 别处抄来的 Grok 格式，兼容
 *   4. <photo>1girl, solo, smile</photo>    —— 老版本的纯标签写法，兼容
 *
 * 返回的 index 是这块在原文里的位置，slot 是它的序号（用来对应已出的图）。
 */
const BLOCK_TAGS = 'photo|image|mossimg';

function cleanTitle(raw) {
  return String(raw || '')
    .replace(/^【|】$/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

function parseBlockInner(attrs, inner) {
  let title = (readAttr(attrs, 'title') || readAttr(attrs, 'caption') || '').trim();
  const kindRaw = (readAttr(attrs, 'kind') || readAttr(attrs, 'scene') || '').toLowerCase();
  const kind = /private|nsfw|私密/.test(kindRaw) ? 'private' : (/scene|wide|场景/.test(kindRaw) ? 'scene' : 'selfie');
  // 提示词也可以直接写在属性里：<photo tags="…">文本</photo> / <photo prompt="…" />
  const attrPrompt = (readAttr(attrs, 'prompt') || readAttr(attrs, 'tags') || readAttr(attrs, 'text') || '').trim();
  let body = attrPrompt || String(inner || '').trim();

  // 3. Grok：标题行 + image###提示词###
  const gm = body.match(/^([\s\S]*?)\s*image\s*#{3,}\s*([\s\S]*?)\s*#{3,}\s*$/i);
  if (gm) {
    if (!title) title = cleanTitle(gm[1]);
    body = gm[2].trim();
  }

  // 3b. 【标题】开头
  if (!title) {
    const bm = body.match(/^\s*【([^】]{1,60})】\s*/);
    if (bm) { title = cleanTitle(bm[1]); body = body.slice(bm[0].length).trim(); }
  }

  // 2. 标题｜提示词（只取第一处，标题不能太长也不能跨行）
  if (!title) {
    const sm = body.match(/^([^\n｜|]{1,40})\s*[｜|]\s*([\s\S]+)$/);
    if (sm) { title = cleanTitle(sm[1]); body = sm[2].trim(); }
  }

  // 残留的 ### 围栏
  body = body.replace(/^#{3,}\s*/, '').replace(/\s*#{3,}$/, '').trim();

  return { title, prompt: body, kind };
}

export function parseImageBlocks(rawText) {
  const text = String(rawText || '');
  const items = [];
  const spans = [];
  if (!new RegExp(`<(${BLOCK_TAGS})\\b`, 'i').test(text)) return { items, cleanText: text };

  const pair = new RegExp(`<(${BLOCK_TAGS})\\b([^>]*)>([\\s\\S]*?)<\\/\\1\\s*>`, 'gi');
  let m;
  while ((m = pair.exec(text)) !== null) {
    const [, tag, attrs, inner] = m;
    const parsed = parseBlockInner(attrs, inner);
    if (!parsed.prompt) continue;
    items.push({ ...parsed, tag, raw: m[0], index: m.index });
    spans.push([m.index, m.index + m[0].length]);
  }

  // 自闭合写法：<photo title="x" prompt="…" />
  const selfRe = new RegExp(`<(${BLOCK_TAGS})\\b([^>]*?)\\/>`, 'gi');
  while ((m = selfRe.exec(text)) !== null) {
    if (spans.some(([a, b]) => m.index >= a && m.index < b)) continue;
    const [, tag, attrs] = m;
    const prompt = readAttr(attrs, 'prompt') || readAttr(attrs, 'tags') || readAttr(attrs, 'text') || '';
    if (!prompt) continue;
    const parsed = parseBlockInner(attrs, '');
    items.push({ ...parsed, prompt, tag, raw: m[0], index: m.index });
    spans.push([m.index, m.index + m[0].length]);
  }

  items.sort((a, b) => a.index - b.index);
  items.forEach((it, i) => { it.slot = i; });

  // 剥掉所有块，剩下的就是干净正文（给"手动按钮"和调试用）
  let cleanText = text;
  for (const it of [...items].sort((a, b) => b.index - a.index)) {
    cleanText = cleanText.slice(0, it.index) + cleanText.slice(it.index + it.raw.length);
  }
  cleanText = cleanText.replace(/\n{3,}/g, '\n\n').trim();

  return { items, cleanText };
}

/**
 * 正文里形如 <photo kind="selfie" tags="..." caption="..."/> 的控制标签。
 * stripOthers 默认 false —— 酒馆里 <UpdateVariable> 这类标签是别的扩展要用的，
 * 只有独立版才需要顺手清掉。
 */
export function parseControlTags(rawText, { stripOthers = false } = {}) {
  const { items, cleanText } = parseImageBlocks(rawText);
  let text = cleanText;
  const out = { cleanText: text, photo: null, items, removed: [] };

  if (items.length) {
    const first = items[0];
    out.photo = { kind: first.kind, tags: first.prompt, caption: first.title };
    out.removed.push('photo');
  }
  // 兜底：只写了 </photo> 没写开标签之类的残缺情况，别把闭合标签漏进正文
  if (new RegExp(`</(?:${BLOCK_TAGS})\\s*>`, 'i').test(text)) {
    text = text.replace(new RegExp(`</(?:${BLOCK_TAGS})\\s*>`, 'gi'), '');
  }

  // 顺带清掉这张卡里其它控制标签，避免它们跑进提示词
  if (stripOthers) {
    for (const name of ['delta', 'meetup', 'UpdateVariable', 'status_current_variables']) {
      const re = new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?<\\/${name}>|<${name}\\b[^>]*?\\/>`, 'gi');
      if (re.test(text)) {
        text = text.replace(re, '');
        out.removed.push(name);
      }
    }
  }

  out.cleanText = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

/* ────────── 关键词判定 ────────── */

const SELFIE_RE = /自拍|拍张照|发张照|拍个照|发张照片|看看你现在|看看穿搭|照片|写真|镜头/;
const PRIVATE_RE = /私密|私房|福利|内衣|睡衣|裸|色色|性感照|床照|浴室|泡澡/;
const REFUSE_RE = /不行|不要|不拍|休想|拒绝|改天/;

/** 从正文猜图片类型：不猜也能手动选 */
export function detectKind(rawText) {
  const t = String(rawText || '');
  if (REFUSE_RE.test(t) && !PRIVATE_RE.test(t)) return null;
  if (PRIVATE_RE.test(t)) return 'private';
  if (SELFIE_RE.test(t)) return 'selfie';
  return null;
}

/* ────────── 离线规则抽取 ────────── */

const DICT = {
  scene: {
    卧室: 'bedroom', 床上: 'on bed', 浴室: 'bathroom', 浴缸: 'bathtub', 淋浴: 'shower',
    客厅: 'living room', 沙发: 'on sofa', 厨房: 'kitchen', 教室: 'classroom', 办公室: 'office',
    走廊: 'corridor', 天台: 'rooftop', 屋顶: 'rooftop', 阳台: 'balcony', 楼梯: 'staircase',
    街头: 'street', 巷子: 'alley', 车站: 'train station', 电车: 'train interior', 地铁: 'subway',
    咖啡店: 'cafe', 咖啡馆: 'cafe', 酒吧: 'bar', 便利店: 'convenience store', 图书馆: 'library',
    教室外: 'schoolyard', 泳池: 'swimming pool', 海边: 'beach', 沙滩: 'beach', 森林: 'forest',
    神社: 'shrine', 医院: 'hospital', 酒店: 'hotel room', 镜子前: 'in front of mirror',
    窗边: 'by the window', 落地窗: 'floor-to-ceiling window', 雨: 'rain', 雪: 'snow',
  },
  pose: {
    身体前倾: 'leaning forward', 前倾: 'leaning forward', 靠在: 'leaning', 靠着: 'leaning', 倚着: 'leaning',
    回头看: 'looking back', 回头: 'looking back', 侧身: 'from side', 抬头: 'looking up', 低头: 'looking down',
    坐着: 'sitting', 站着: 'standing', 躺着: 'lying', 趴着: 'on stomach', 跪着: 'kneeling',
    蹲着: 'squatting', 伸懒腰: 'stretching', 抱膝: 'hugging own legs', 交叉腿: 'crossed legs',
    撩头发: 'hand in hair', 托腮: 'hand on own cheek', 举手: 'arm up', 背手: 'arms behind back',
    侧卧: 'on side', 拥抱: 'hug', 牵手: 'holding hands', 双手抱胸: 'crossed arms',
  },
  expression: {
    脸有点红: 'blush', 有点红: 'blush', 泛红: 'blush', 微红: 'blush', 脸红: 'blush',
    微笑: 'smile', 笑: 'smile', 大笑: 'laughing', 害羞: 'embarrassed', 羞: 'embarrassed',
    哭: 'crying', 生气: 'angry', 惊讶: 'surprised', 困: 'sleepy', 闭眼: 'closed eyes',
    媚眼: 'seductive smile', 舔唇: 'licking lips', 咬唇: 'biting lip', 无表情: 'expressionless',
    平静: 'calm', 认真: 'serious', 得意: 'smug', 张嘴: 'open mouth', 眯眼: 'half-closed eyes',
  },
  camera: {
    特写: 'close-up', 脸部特写: 'face close-up', 全身: 'full body', 上半身: 'upper body',
    半身: 'cowboy shot', 背影: 'from behind', 俯视: 'from above', 仰视: 'from below',
    侧面: 'from side', 正面: 'front view', 广角: 'wide shot', 低角度: 'low angle',
    自拍视角: 'selfie', 抓拍: 'candid',
  },
  light: {
    夜景: 'night', 黄昏: 'sunset', 夕阳: 'sunset', 清晨: 'morning', 午后: 'afternoon',
    霓虹: 'neon lights', 昏黄: 'warm lighting', 逆光: 'backlighting', 月光: 'moonlight',
    室内光: 'indoor lighting', 烛光: 'candlelight', 昏暗: 'dim lighting', 明亮: 'bright',
  },
  outfitState: {
    白衬衫: 'white shirt', 湿透: 'wet clothes', 湿: 'wet clothes', 半脱: 'partially undressed',
    解开: 'unbuttoned', 全裸: 'completely nude', 赤裸: 'nude', 内衣: 'underwear',
    睡衣: 'pajamas', 浴巾: 'towel', 衬衫: 'shirt', 吊带: 'camisole', 制服: 'uniform',
    校服: 'school uniform', 百褶裙: 'pleated skirt', 短裙: 'skirt', 连衣裙: 'dress',
    丝袜: 'pantyhose', 高跟鞋: 'high heels',
  },
};

const DICT_ORDER = ['camera', 'expression', 'pose', 'scene', 'light', 'outfitState'];

/** 「white shirt」在时把「shirt」去掉、「leaning forward」在时把「leaning」去掉，别让模型收到重复词 */
function pruneRedundant(tags) {
  const hasWordSeq = (haystack, needle) => {
    const h = haystack.split(/\s+/);
    const n = needle.split(/\s+/);
    for (let i = 0; i + n.length <= h.length; i++) {
      if (n.every((w, j) => h[i + j] === w)) return true;
    }
    return false;
  };
  return tags.filter(t => !tags.some(o => o !== t && hasWordSeq(o, t)));
}

/**
 * 纯离线：扫中文关键词直接映射成 danbooru 标签。
 * 没有大模型也能出一版可用的提示词，命中不了就返回空数组。
 */
export function ruleExtract(rawText) {
  const text = String(rawText || '');
  const hits = [];
  const tags = [];
  for (const group of DICT_ORDER) {
    for (const [zh, en] of Object.entries(DICT[group])) {
      if (!text.includes(zh)) continue;
      if (tags.includes(en)) continue;
      tags.push(en);
      hits.push({ zh, en, group });
    }
  }
  return { tags: pruneRedundant(tags), hits };
}

/** 从正文里直接抠出英文标签行，例如 `tags: 1girl, smile, bedroom` */
export function extractTagLines(rawText) {
  const text = String(rawText || '');
  const out = [];
  const re = /(?:^|\n)\s*(?:tags?|标签|prompt)\s*[:：]\s*([^\n]+)/gi;
  let m;
  while ((m = re.exec(text))) {
    const line = m[1].trim();
    if (line) out.push(...splitTags(line));
  }
  return out;
}

export function splitTags(str) {
  return String(str || '')
    .split(/[,，、\n]/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.replace(/^[（(]|[)）]$/g, '').trim())
    .filter(s => s && !/^[\u4e00-\u9fff]+$/.test(s));
}

/** 整段几乎全是英文标签（无中文正文）时，直接当标签用 */
export function looksLikeTagsOnly(rawText) {
  const t = String(rawText || '').trim();
  if (!t || t.length > 400) return false;
  if (/[\u4e00-\u9fff]/.test(t)) return false;
  const parts = splitTags(t);
  return parts.length >= 3;
}

/* ────────── 权重语法（可选） ────────── */

/** NAI 的 (tag:1.2) 在 SDXL 系里通用；MOSS 这类 Qwen 编码器基本无效，默认关闭 */
export function convertWeights(str) {
  return String(str || '')
    .replace(/\{\{([^{}|]+)\|([^{}]+)\}\}/g, (_m, a, b) => `(${a.trim()}:1.1)`)
    .replace(/\[\s*([^\]]+?)\s*\]/g, (_m, a) => `(${a.trim()}:0.9)`);
}

/* ────────── 拼装 ────────── */

export function buildPrompt({ prefix = '', tags = '', identity = '', suffix = '', dedupe = true, natural = false } = {}) {
  const parts = [prefix, identity, tags, suffix].map(s => String(s || '').trim()).filter(Boolean);

  /*
   * natural 模式：tags 是一整段中文描述，不能按逗号切开再用 ", " 拼回去
   * （会把中文的「，」全部换成西文逗号，读起来像坏掉的句子）。
   * 这里保留原文，用全角逗号把固定前缀/身份/后缀接上。
   */
  if (natural) {
    const seen = new Set();
    return parts.filter((p) => {
      if (seen.has(p)) return false;
      seen.add(p);
      return true;
    }).join('，');
  }

  const segs = [];
  const push = (s) => {
    String(s || '')
      .split(/[,，]/)
      .map(x => x.trim())
      .filter(Boolean)
      .forEach(x => segs.push(x));
  };
  push(prefix);
  push(identity);
  push(tags);
  push(suffix);

  if (!dedupe) return segs.join(', ');
  const seen = new Set();
  const out = [];
  for (const s of segs) {
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out.join(', ');
}

/* ────────── 大模型解析 ────────── */

/**
 * 清洗大模型吐回来的标签。
 *
 * 注意列表编号的正则：**必须要求编号后面跟空白**。
 * 早先的写法把「连字符、星号、数字、点、顿号」一股脑当成列表标记，
 * 结果 "1girl" 的 1 被当编号吃掉，变成 "girl"，
 * 而 1girl / 2girls 是 danbooru 里最基础的标签，一吃整张图就变味了。
 */
export function cleanTagOutput(raw, { asciiOnly = false } = {}) {
  let s = String(raw || '').trim();
  s = s.replace(/^```[a-z]*\s*/i, '').replace(/```$/, '').trim();
  // 模型有时会写 "Tags: xxx" 或编号/破折号列表
  s = s.replace(/^(?:tags?|prompt|提示词|标签)\s*[:：]\s*/i, '');
  const LIST_MARK = /^\s*(?:[-*•]\s+|\d+[.)、]\s*)/;
  const lines = s.split('\n').map(l => l.replace(LIST_MARK, '').trim()).filter(Boolean);
  let segs = lines.join(', ')
    .split(/[,，]/)
    .map(t => t.trim())
    .filter(Boolean)
    .filter(t => t.length <= 80);
  // asciiOnly：模型偶尔会跑成中文解说，那些不是标签
  if (asciiOnly) segs = segs.filter(t => !/[\u4e00-\u9fff\u3040-\u30ff]/.test(t));
  return segs.join(', ');
}

const SYS_TAGS = [
  'You are a Danbooru tag parser for an image generation model that expects comma-separated tags.',
  'Convert the story text into 8-16 concise English Danbooru tags covering ONLY: pose/action, expression, camera angle/framing, background, lighting.',
  'Do NOT describe hair color, eye color, body shape, or clothing — those are fixed elsewhere.',
  'Do not invent characters. Do not add quality words like masterpiece.',
  'Output comma-separated English tags only, no explanation, no markdown.',
].join(' ');

const SYS_NATURAL = [
  '你是一个中文画面描述写手，为文生图模型服务。',
  '把给出的剧情片段改写成一段 80–150 字的连贯中文画面描述，只写「此刻这一帧」：',
  '画面里有谁、在做什么、表情与视线、镜头远近与角度、环境与背景、光线与色调。',
  '原文没提到的发色、瞳色、服装细节不要凭空添加；不要出现 tag 列表、不要分点、不要英文、不要标题、不要解释。',
  '直接输出这一段描述本身。',
].join(' ');

export { SYS_TAGS, SYS_NATURAL };

/** 组装给解析模型的 messages，酒馆扩展和独立服务共用 */
export function buildParserMessages({ text = '', kind = 'selfie', mode = 'natural' } = {}) {
  const kindHint = kind === 'private'
    ? '画面类型：私密空间里的一张亲密、私房的照片。'
    : kind === 'scene'
      ? '画面类型：一个电影感的场景镜头，取景更宽。'
      : '画面类型：一张随手拍的生活照 / 自拍。';
  return [
    { role: 'system', content: mode === 'natural' ? SYS_NATURAL : SYS_TAGS },
    { role: 'user', content: `${kindHint}\n\n剧情片段：\n${String(text).slice(0, 4000)}` },
  ];
}

/**
 * 用外部注入的 llmCall(systemContent, userContent) => Promise<string> 做解析。
 * 酒馆里 llmCall 是 generateQuietPrompt（直接用当前对话模型），
 * 独立服务里是 fetch 一个 OpenAI 兼容接口 —— 两边共用同一套提示词与清洗逻辑。
 * 失败返回 null，让调用方退回离线词典，解析失败不该阻断生图。
 */
export async function parseWithLLM({ text = '', kind = 'selfie', mode = 'tags', llmCall } = {}) {
  const story = String(text || '').trim();
  if (!story || typeof llmCall !== 'function') return null;
  const messages = buildParserMessages({ text: story, kind, mode });
  const raw = await llmCall(messages[0].content, messages[1].content);
  if (!raw || !String(raw).trim()) return null;
  return mode === 'natural' ? String(raw).trim().replace(/\s+/g, ' ') : cleanTagOutput(raw);
}

/* ────────── 一站式 ────────── */

/**
 * 正文 → 提示词。UI 里「提取标签」按钮就是调它。
 * 顺序：控制标签 → 英文标签行 → 规则词典；（可选）大模型覆盖。
 */
export async function extractPrompt({
  text = '',
  kind = null,
  useLLM = false,
  llmCall = null,
  llmMode = 'tags',
  prefix = '',
  identity = '',
  suffix = '',
  weights = false,
} = {}) {
  const parsed = parseControlTags(text);
  const inferred = kind || parsed.photo?.kind || detectKind(parsed.cleanText) || 'selfie';

  const collected = [];
  const notes = [];

  if (parsed.photo?.tags) {
    collected.push(...splitTags(parsed.photo.tags));
    notes.push('用了 <photo> 标签里的 tags');
  }
  const lineTags = extractTagLines(parsed.cleanText);
  if (lineTags.length) {
    collected.push(...lineTags);
    notes.push('抓到了正文里的标签行');
  }

  if (!collected.length && looksLikeTagsOnly(parsed.cleanText)) {
    collected.push(...splitTags(parsed.cleanText));
    notes.push('正文本身就是标签串');
  }

  let llmText = '';
  if (useLLM) {
    try {
      const out = await parseWithLLM({ text: parsed.cleanText, kind: inferred, mode: llmMode, llmCall });
      if (out) {
        llmText = out;
        notes.push(llmMode === 'natural' ? '大模型写了自然语言描述' : '大模型解析出场景标签');
      } else {
        notes.push('大模型没返回内容，用了规则结果');
      }
    } catch (e) {
      notes.push(`大模型解析失败：${e.message}（已退回规则结果）`);
    }
  }

  let tags = collected.join(', ');
  if (!tags && !llmText) {
    const rule = ruleExtract(parsed.cleanText);
    tags = rule.tags.join(', ');
    const kept = new Set(rule.tags);
    const hits = rule.hits.filter(h => kept.has(h.en));
    if (hits.length) notes.push(`规则命中 ${hits.length} 个词：${hits.map(h => h.zh).join('、')}`);
    else notes.push('没抓到可用标签，手动补几个吧');
  }

  const rawTags = llmText || tags;
  const finalTags = weights ? convertWeights(rawTags) : rawTags;

  return {
    kind: inferred,
    cleanText: parsed.cleanText,
    tags: finalTags,
    caption: parsed.photo?.caption || '',
    prompt: buildPrompt({ prefix, identity, tags: finalTags, suffix }),
    notes,
    removedTags: parsed.removed,
  };
}
