/**
 * comfy-client.js —— ComfyUI 原生工作流客户端
 *
 * 移植自角色卡《AV制作大亨》04 号脚本的生图层（原 3005–3172 / 2744–2939 / 2669–3002 行），
 * 移除了 NovelAI 后端、内置预设工作流、角色卡业务耦合，只留「把词塞进任意 API 工作流并取回图」这件事。
 *
 * 对外就一个主入口：
 *   const res = await generate({ base, workflow, positive, ... })
 *   res = { dataUrl, promptId, seed, elapsedMs, images }
 *
 * 纯函数 + fetch，不碰 DOM，浏览器和 Node 都能跑（端到端测试就是这么跑的）。
 */

export const DEFAULT_BASE = 'http://127.0.0.1:8188';

/* ────────────────────────── 错误 ────────────────────────── */

export class ComfyError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'ComfyError';
    Object.assign(this, info);
  }
}

/* ────────────────────────── 地址与传输 ────────────────────────── */

const LOCAL_HOST_RE = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|10\.\d|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i;
const IP_LIKE_RE = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/|$)/;

export function normalizeBaseUrl(raw) {
  let target = String(raw ?? '').trim() || DEFAULT_BASE;
  if (!target.startsWith('/') && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) {
    target = (LOCAL_HOST_RE.test(target) || IP_LIKE_RE.test(target) ? 'http://' : 'https://') + target;
  }
  let u;
  try {
    u = new URL(target);
  } catch {
    throw new ComfyError(`地址格式不对：${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new ComfyError('地址只支持 http / https');
  }
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

/**
 * 传输层（酒馆版）
 *
 * 浏览器直接 fetch ComfyUI 需要 ComfyUI 开 --enable-cors-header。
 * 没开的话退回酒馆自带的跨域代理 `/proxy/<完整地址>`（需要酒馆设置里 enableCorsProxy 打开）。
 * 两条都走不通时，把两条错误都带上，别只报一句"网络错误"。
 */
export function makeTransport({ base = DEFAULT_BASE, stProxy = true } = {}) {
  const clean = normalizeBaseUrl(base);
  return {
    base: clean,
    stProxy: Boolean(stProxy),
    url: (path) => clean + path,
    proxyUrl: (path) => `/proxy/${clean}${path}`,
    async request(path, init = {}, timeoutMs = 30000) {
      let directErr = null;
      try {
        return await rawFetch(clean + path, init, timeoutMs);
      } catch (err) {
        directErr = err;
      }
      if (!this.stProxy) throw buildConnectError(clean, directErr, null, '');

      let res = null;
      let proxyErr = null;
      try {
        res = await rawFetch(`/proxy/${clean}${path}`, init, Math.min(timeoutMs, 20000));
      } catch (err2) {
        proxyErr = err2;
      }

      // 酒馆没开跨域代理时，/proxy/* 是一条"存在但拒绝"的路由，返回 404 + "CORS proxy is disabled"。
      // 这不是网络故障，别把它当成主错误甩给用户，否则会误以为要改 ComfyUI。
      if (res && res.status === 404) {
        let note = '酒馆的跨域代理没开（config.yaml → enableCorsProxy），没有备用通道';
        try {
          const t = await res.clone().text();
          if (!/cors proxy is disabled/i.test(t)) note = '酒馆代理返回 404';
        } catch { /* 读不到就按默认说法 */ }
        throw buildConnectError(clean, directErr, null, note);
      }
      if (!res) throw buildConnectError(clean, directErr, proxyErr, '');
      return res;
    },
  };
}

function buildConnectError(base, directErr, proxyErr, proxyNote) {
  const head = `连不上 ComfyUI（${base}）`;
  const parts = [];
  if (directErr) parts.push(`直连：${directErr.message}`);
  if (proxyErr) parts.push(`酒馆代理：${proxyErr.message}`);
  if (proxyNote) parts.push(proxyNote);
  const hint = '→ 确认 ComfyUI 已经启动、地址和端口对得上；'
    + '也可以把酒馆 config.yaml 里的 enableCorsProxy 改成 true 走代理。';
  return new ComfyError(`${head}。${parts.join('；')}。${hint}`, {
    cause: directErr, localOnly: true, needProxy: Boolean(proxyErr || proxyNote),
  });
}

async function rawFetch(url, init = {}, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
  } catch (err) {
    if (err?.name === 'AbortError') throw new ComfyError(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    throw new ComfyError(`请求发不出去：${err?.message || err}`);
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(t, path, init, timeoutMs) {
  const res = await t.request(path, init, timeoutMs);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch { /* 非 JSON，保留原文 */ }
  return { ok: res.ok, status: res.status, statusText: res.statusText, text, json };
}

/* ────────────────────────── 工作流常量 ────────────────────────── */

// 文本输入可能出现的字段名：普通编码器写 text，SDXL 双编码器写 text_g / text_l，Flux 写 clip_l / t5xxl
const ENCODE_TEXT_FIELDS = ['text', 'text_g', 'text_l', 'clip_l', 't5xxl'];
const TEXT_FIELDS = [...ENCODE_TEXT_FIELDS, 'prompt', 'string', 'value'];
const SAMPLER_RE = /KSampler|SamplerCustom/i;
const LATENT_RE = /^Empty(?:SD3|Flux2?)?LatentImage$/i;
const OUTPUT_RE = /SaveImage|PreviewImage|SaveAnimated/i;
const SEED_CLASS_RE = /KSampler|Sampler|Noise|Seed|Detailer|Wildcard/i;

export const PLACEHOLDERS = [
  'positive', 'negative', 'seed', 'width', 'height',
  'ckpt_name', 'unet_name', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise',
];

const isLink = v => Array.isArray(v) && v.length === 2 && (typeof v[0] === 'string' || typeof v[0] === 'number');
const nodeEntries = wf => Object.entries(wf).filter(([, n]) => n && typeof n === 'object' && n.class_type);
const nodeTitle = n => String(n?._meta?.title || n?.class_type || '');

/** 取模型加载节点里可改写的字段名 */
function modelFieldOf(classType) {
  const ct = String(classType || '');
  if (ct === 'CheckpointLoaderSimple') return 'ckpt_name';
  if (/^(?:UNETLoader|DiffusionModelLoader|UnetLoaderGGUF)$/i.test(ct)) return 'unet_name';
  return '';
}

function getEditableTextFields(node) {
  if (!node || typeof node !== 'object' || !node.inputs) return [];
  const inp = node.inputs;
  const enc = ENCODE_TEXT_FIELDS.filter(f => typeof inp[f] === 'string');
  if (enc.length) return enc;
  if (/String|Text|Prompt|Wildcard|Primitive|Note/i.test(String(node.class_type || ''))) {
    const sf = TEXT_FIELDS.find(f => typeof inp[f] === 'string');
    if (sf) return [sf];
  }
  return [];
}

/**
 * 从采样器的 positive / negative 连线往上游递归找写文字的节点。
 * 中间可以穿过 ConditioningCombine / SetArea 之类的条件节点；
 * ConditioningZeroOut 直接判定为「这条分支没有词」（MOSS 工作流就是用它当负面）。
 */
function findTextTargets(wf, startId, branch, seen = new Set()) {
  const id = String(startId);
  if (seen.has(id)) return [];
  seen.add(id);
  const node = wf[id];
  if (!node?.inputs) return [];
  const ct = String(node.class_type || '');
  // 负面被零化（MOSS 工作流的常见写法）：这条分支没有词，别再往上游追
  if (/^ConditioningZeroOut$/i.test(ct)) return [];

  const inp = node.inputs;
  const direct = ENCODE_TEXT_FIELDS.filter(f => typeof inp[f] === 'string');
  if (direct.length) return [{ id, fields: direct }];

  const linked = ENCODE_TEXT_FIELDS.filter(f => isLink(inp[f]));
  if (linked.length) {
    const out = [];
    for (const f of linked) {
      const srcId = String(inp[f][0]);
      const src = wf[srcId];
      const sf = TEXT_FIELDS.find(k => typeof src?.inputs?.[k] === 'string');
      if (sf) out.push({ id: srcId, fields: [sf] });
    }
    if (out.length) return out;
  }

  const found = [];
  for (const [k, v] of Object.entries(inp)) {
    if (!isLink(v)) continue;
    if (branch === 'positive' && /neg/i.test(k)) continue;
    if (branch === 'negative' && /pos/i.test(k)) continue;
    const isCond = /conditioning|positive|negative|^cond/i.test(k) || /Conditioning/i.test(ct);
    if (!isCond) continue;
    found.push(...findTextTargets(wf, v[0], branch, seen));
  }
  return found;
}

/* ────────────────────────── 工作流检视 ────────────────────────── */

/**
 * 把一份 API 格式工作流读懂：哪些节点能改词、能改尺寸、能改模型、采样参数是多少。
 * 返回的对象直接拿去渲染「节点映射」面板。
 */
export function inspectWorkflow(rawWorkflow) {
  const raw = typeof rawWorkflow === 'string' ? rawWorkflow.trim() : JSON.stringify(rawWorkflow ?? null);
  if (!raw || raw === 'null') {
    return { ok: false, error: '工作流是空的' };
  }
  let wf;
  try {
    wf = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `JSON 语法错误：${e?.message || e}` };
  }
  if (!wf || typeof wf !== 'object' || Array.isArray(wf)) {
    return { ok: false, error: '工作流 JSON 根节点必须是对象' };
  }
  if (Array.isArray(wf.nodes) && !nodeEntries(wf).length) {
    return {
      ok: false,
      isCanvasFormat: true,
      error: '这是画布格式。请在 ComfyUI 打开 Dev Mode（设置里勾选 Enable Dev mode Options），再用「Export (API)」导出',
    };
  }

  const entries = nodeEntries(wf);
  if (!entries.length) return { ok: false, error: '没找到任何 class_type 节点，确认是 API 格式吗？' };

  const placeholders = Array.from(new Set(
    (raw.match(/\{\{(positive|negative|seed|width|height|ckpt_name|unet_name|steps|cfg|sampler_name|scheduler|denoise)\}\}/g) || [])
      .map(s => s.slice(2, -2)),
  ));

  const posMap = new Map();
  const negMap = new Map();
  const samplers = [];
  const models = [];
  const latents = [];
  const outputs = [];
  const warnings = [];

  for (const [id, node] of entries) {
    const ct = String(node.class_type);
    const inp = node.inputs || {};

    if (SAMPLER_RE.test(ct)) {
      samplers.push({
        id,
        classType: ct,
        title: nodeTitle(node),
        steps: Number.isFinite(inp.steps) ? inp.steps : null,
        cfg: Number.isFinite(inp.cfg) ? inp.cfg : null,
        samplerName: inp.sampler_name || '',
        scheduler: inp.scheduler || '',
        seed: Number.isFinite(inp.seed) ? inp.seed : (Number.isFinite(inp.noise_seed) ? inp.noise_seed : null),
      });
    }
    const mf = modelFieldOf(ct);
    if (mf && typeof inp[mf] === 'string') {
      models.push({ id, classType: ct, title: nodeTitle(node), field: mf, value: inp[mf] });
    }
    if (LATENT_RE.test(ct)) {
      latents.push({ id, classType: ct, title: nodeTitle(node), width: inp.width, height: inp.height });
    }
    if (OUTPUT_RE.test(ct)) outputs.push({ id, classType: ct, title: nodeTitle(node) });

    const posStart = isLink(inp.positive)
      ? inp.positive
      : (/Guider/i.test(ct) && isLink(inp.conditioning) ? inp.conditioning : null);
    if (posStart) for (const t of findTextTargets(wf, posStart[0], 'positive')) posMap.set(t.id, t.fields);
    if (isLink(inp.negative)) for (const t of findTextTargets(wf, inp.negative[0], 'negative')) negMap.set(t.id, t.fields);
  }

  const textNodes = [];
  for (const [id, node] of entries) {
    const fields = getEditableTextFields(node);
    if (!fields.length) continue;
    const val = String(node.inputs[fields[0]] ?? '').replace(/\s+/g, ' ').trim();
    textNodes.push({
      id,
      classType: String(node.class_type),
      title: nodeTitle(node),
      fields,
      role: posMap.has(id) ? 'positive' : (negMap.has(id) ? 'negative' : 'other'),
      preview: val.slice(0, 80),
    });
  }
  textNodes.sort((a, b) => {
    const rank = r => (r === 'positive' ? 0 : r === 'negative' ? 1 : 2);
    return rank(a.role) - rank(b.role) || Number(a.id) - Number(b.id);
  });

  // 负面被零化（MOSS 常见写法）：告知用户负面词没处放
  const zeroNeg = entries.some(([, n]) => /ConditioningZeroOut/i.test(String(n.class_type))
    && (negMap.size === 0));

  if (!samplers.length) warnings.push('没找到 KSampler / SamplerCustom，工作流可能不完整');
  if (!outputs.length) warnings.push('没找到 SaveImage / PreviewImage，出图后取不到结果');
  if (!posMap.size && !placeholders.includes('positive')) {
    warnings.push('没能自动定位正面文本节点，请在下方手动指定，或在节点文字里写 {{positive}}');
  }
  if (zeroNeg) warnings.push('负面分支接的是 ConditioningZeroOut（负面被零化），注入负面词也不会生效');

  const primarySampler = samplers[0] || null;

  return {
    ok: true,
    workflow: wf,
    nodeCount: entries.length,
    placeholders,
    samplers,
    models,
    latents,
    outputs,
    textNodes,
    positiveTargets: textNodes.filter(n => n.role === 'positive'),
    negativeTargets: textNodes.filter(n => n.role === 'negative'),
    zeroNeg,
    warnings,
    // 「跟随工作流」用的实际参数
    inferred: primarySampler ? {
      steps: primarySampler.steps,
      cfg: primarySampler.cfg,
      samplerName: primarySampler.samplerName,
      scheduler: primarySampler.scheduler,
      seed: primarySampler.seed,
    } : null,
    size: latents[0] ? { width: latents[0].width, height: latents[0].height } : null,
    model: models[0] ? models[0].value : '',
  };
}

/* ────────────────────────── 注入 ────────────────────────── */

function escapeJsonString(s) {
  return JSON.stringify(String(s ?? '')).slice(1, -1);
}

function joinPrompt(existing, added, mode = 'append') {
  const add = String(added ?? '').trim();
  if (!add) return String(existing ?? '');
  const cur = String(existing ?? '').trim();
  if (mode === 'replace' || !cur) return add;
  return /[,，]\s*$/.test(cur) ? `${cur} ${add}` : `${cur}, ${add}`;
}

function randomizeSeeds(wf, seed) {
  for (const node of Object.values(wf)) {
    if (!node || typeof node !== 'object' || !node.inputs) continue;
    if (!SEED_CLASS_RE.test(String(node.class_type || ''))) continue;
    for (const key of ['seed', 'noise_seed']) {
      const v = node.inputs[key];
      if (typeof v === 'number') {
        node.inputs[key] = seed;
      } else if (isLink(v)) {
        const src = wf[String(v[0])];
        const sk = ['value', 'seed', 'noise_seed', 'int'].find(x => typeof src?.inputs?.[x] === 'number');
        if (sk) src.inputs[sk] = seed;
      }
    }
  }
}

/**
 * 把参数灌进工作流，返回可直接 POST 的对象。
 *
 * 优先级：占位符 > 手动指定节点 > 连线自动定位。
 * 负面词默认完全不动 —— 保住别人工作流里精调过的负面词。
 */
export function hydrateWorkflow(rawWorkflow, options = {}) {
  const {
    positive = '',
    negative = '',
    seed = Math.floor(Math.random() * 4294967290) + 1,
    width = null,
    height = null,
    modelName = '',
    steps = null,
    cfg = null,
    samplerName = '',
    scheduler = '',
    denoise = null,
    overrideSampling = false,
    overrideSize = false,
    overrideModel = false,
    positiveNodeId = '',
    positiveMode = 'append',
    negativeNodeId = '',
    negativeMode = 'replace',
  } = options;

  const raw = typeof rawWorkflow === 'string' ? rawWorkflow : JSON.stringify(rawWorkflow);
  const hasPositivePh = /\{\{positive\}\}/.test(raw);
  const hasNegativePh = /\{\{negative\}\}/.test(raw);
  const hasSeedPh = /\{\{seed\}\}/.test(raw);

  const numMap = { seed: String(seed) };
  if (Number.isFinite(width)) numMap.width = String(width);
  if (Number.isFinite(height)) numMap.height = String(height);
  if (Number.isFinite(steps)) numMap.steps = String(steps);
  if (Number.isFinite(cfg)) numMap.cfg = String(cfg);
  if (Number.isFinite(denoise)) numMap.denoise = String(denoise);

  const strMap = {
    positive: escapeJsonString(positive),
    negative: escapeJsonString(negative),
    ckpt_name: escapeJsonString(modelName),
    unet_name: escapeJsonString(modelName),
    sampler_name: escapeJsonString(samplerName),
    scheduler: escapeJsonString(scheduler),
  };

  // 单遍替换，避免正向词里恰好含有 {{negative}} 之类的文本被二次污染
  const replaced = raw.replace(
    /"\{\{(positive|negative|seed|width|height|ckpt_name|unet_name|steps|cfg|sampler_name|scheduler|denoise)\}\}"|\{\{(positive|negative|seed|width|height|ckpt_name|unet_name|steps|cfg|sampler_name|scheduler|denoise)\}\}/g,
    (whole, quotedKey, rawKey) => {
      const key = quotedKey || rawKey;
      if (key in numMap) return quotedKey ? numMap[key] : numMap[key];
      if (key in strMap && strMap[key]) return quotedKey ? `"${strMap[key]}"` : strMap[key];
      return whole;
    },
  );

  let wf;
  try {
    wf = JSON.parse(replaced);
  } catch (e) {
    throw new ComfyError(`工作流 JSON 解析失败：${e?.message || e}`);
  }

  const warnings = [];

  if (!hasSeedPh) randomizeSeeds(wf, seed);

  // 正面词
  if (!hasPositivePh) {
    if (positiveNodeId && wf[positiveNodeId]) {
      const fields = getEditableTextFields(wf[positiveNodeId]);
      if (fields.length) {
        for (const f of fields) {
          wf[positiveNodeId].inputs[f] = joinPrompt(wf[positiveNodeId].inputs[f], positive, positiveMode);
        }
      } else {
        warnings.push(`节点 #${positiveNodeId} 没有可写的文本字段`);
      }
    } else {
      const targets = new Map();
      const entries = nodeEntries(wf);
      for (const [id, node] of entries) {
        const inp = node.inputs || {};
        const start = isLink(inp.positive)
          ? inp.positive
          : (/Guider/i.test(String(node.class_type)) && isLink(inp.conditioning) ? inp.conditioning : null);
        if (!start) continue;
        for (const t of findTextTargets(wf, start[0], 'positive')) targets.set(t.id, t.fields);
      }
      if (!targets.size) {
        warnings.push('没能自动定位正面文本节点，提示词没写进去 —— 请手动指定或在节点里写 {{positive}}');
      }
      for (const [id, fields] of targets) {
        for (const f of fields) wf[id].inputs[f] = joinPrompt(wf[id].inputs[f], positive, positiveMode);
      }
    }
  }

  // 负面词：只有写了占位符、或显式指定了节点才动
  if (!hasNegativePh && negativeNodeId && wf[negativeNodeId] && negative) {
    const fields = getEditableTextFields(wf[negativeNodeId]);
    if (fields.length) {
      for (const f of fields) wf[negativeNodeId].inputs[f] = joinPrompt(wf[negativeNodeId].inputs[f], negative, negativeMode);
    }
  }

  for (const node of Object.values(wf)) {
    if (!node || typeof node !== 'object' || !node.inputs) continue;
    const ct = String(node.class_type || '');

    if (overrideSize && LATENT_RE.test(ct) && Number.isFinite(width) && Number.isFinite(height)) {
      node.inputs.width = width;
      node.inputs.height = height;
    }
    if (overrideModel && modelName) {
      const mf = modelFieldOf(ct);
      if (mf && mf in node.inputs) node.inputs[mf] = modelName;
    }
    if (overrideSampling && SAMPLER_RE.test(ct)) {
      if (Number.isFinite(steps) && 'steps' in node.inputs) node.inputs.steps = steps;
      if (Number.isFinite(cfg) && 'cfg' in node.inputs) node.inputs.cfg = cfg;
      if (samplerName && 'sampler_name' in node.inputs) node.inputs.sampler_name = samplerName;
      if (scheduler && 'scheduler' in node.inputs) node.inputs.scheduler = scheduler;
      if (Number.isFinite(denoise) && 'denoise' in node.inputs) node.inputs.denoise = denoise;
    }
  }

  return { workflow: wf, warnings, seed };
}

/* ────────────────────────── 服务端信息 ────────────────────────── */

const pickEnum = (json, nodeType, field) => {
  const raw = json?.[nodeType]?.input?.required?.[field]?.[0];
  return Array.isArray(raw) ? raw.map(String).filter(Boolean) : [];
};

/**
 * 拉服务端信息。
 *
 * 为什么要"先单发、再并行"：浏览器对某个源的**第一条连接**可能极慢
 * （实测首次 /system_stats 要 9~70 秒，之后都是个位数毫秒，curl 却一直是 4 毫秒——
 *  典型的 Windows 首次 SYN 被丢、靠重发才连上）。如果一上来就并行发 6 条，
 * 6 条全卡在冷启动里，必然集体超时。所以先用一条请求把连接焐热，再并行拉剩下的。
 *
 * 另外：冷启动**不能中途 abort**，一 abort 下次又是全新冷连接，白等。
 * 所以这里给足 120 秒，且超时后不重试（重试只会再冷一次）。
 */
export async function fetchServerInfo(t, { onStep } = {}) {
  onStep?.('正在连接 ComfyUI…');
  const stats = await getJsonWarm(t, '/system_stats', 120000);

  if (!stats || !stats.ok) {
    const detail = stats?.json?.error || stats?.text?.slice(0, 120) || '无响应';
    throw new ComfyError(`连不上 ComfyUI：${detail}`, { localOnly: true });
  }

  onStep?.('读取模型与采样器列表…');
  const [unet, ckpt, lora, clip, sampler] = await Promise.all([
    getJson(t, '/object_info/UNETLoader', { method: 'GET' }, 30000).catch(() => null),
    getJson(t, '/object_info/CheckpointLoaderSimple', { method: 'GET' }, 30000).catch(() => null),
    getJson(t, '/object_info/LoraLoader', { method: 'GET' }, 30000).catch(() => null),
    getJson(t, '/object_info/CLIPLoader', { method: 'GET' }, 30000).catch(() => null),
    getJson(t, '/object_info/KSampler', { method: 'GET' }, 30000).catch(() => null),
  ]);

  return {
    version: stats.json?.system?.comfyui_version || '',
    device: stats.json?.devices?.[0]?.name || '',
    vramTotal: stats.json?.devices?.[0]?.vram_total || 0,
    unets: unet?.ok ? pickEnum(unet.json, 'UNETLoader', 'unet_name') : [],
    ckpts: ckpt?.ok ? pickEnum(ckpt.json, 'CheckpointLoaderSimple', 'ckpt_name') : [],
    loras: lora?.ok ? pickEnum(lora.json, 'LoraLoader', 'lora_name') : [],
    clips: clip?.ok ? pickEnum(clip.json, 'CLIPLoader', 'clip_name') : [],
    samplers: sampler?.ok ? pickEnum(sampler.json, 'KSampler', 'sampler_name') : [],
    schedulers: sampler?.ok ? pickEnum(sampler.json, 'KSampler', 'scheduler') : [],
  };
}

/**
 * 冷启动连接很慢，且"abort 后重试"会再次冷一次，反而更慢。
 * 所以只在"明确连不上（非超时）"时才重试一次——那种多半是瞬时的端口占用/拒连。
 */
async function getJsonWarm(t, path, timeoutMs = 120000) {
  const first = await getJson(t, path, { method: 'GET' }, timeoutMs).catch((e) => {
    return { ok: false, status: 0, text: e?.message || '', json: null, timedOut: /超时/.test(e?.message || '') };
  });
  if (first.ok) return first;
  if (first.timedOut) return first;
  return getJson(t, path, { method: 'GET' }, timeoutMs).catch(() => first);
}

/* ────────────────────────── 错误翻译 ────────────────────────── */

export function formatSubmitError(status, json, rawText) {
  if (json && typeof json === 'object') {
    const bits = [];
    if (json.error?.message) bits.push(String(json.error.message));
    if (json.error && typeof json.error === 'string') bits.push(json.error);
    if (json.node_errors && typeof json.node_errors === 'object') {
      for (const [nid, nerr] of Object.entries(json.node_errors)) {
        const msg = Array.isArray(nerr?.errors)
          ? nerr.errors.map(e => `${e.message || ''}${e.details ? `（${e.details}）` : ''}`).filter(Boolean).join('；')
          : '';
        if (msg) bits.push(`节点 #${nid}${nerr.class_type ? `（${nerr.class_type}）` : ''}：${msg}`);
      }
    }
    if (bits.length) return `工作流校验失败（${status}）：${bits.join(' ｜ ').slice(0, 300)}`;
  }
  return `提交失败（${status}）：${String(rawText || '').slice(0, 200)}`;
}

export function formatExecError(item) {
  const msgs = Array.isArray(item?.status?.messages) ? item.status.messages : [];
  for (const entry of msgs) {
    if (Array.isArray(entry) && entry[0] === 'execution_error' && entry[1]) {
      const d = entry[1];
      const detail = String(d.exception_message || d.exception_type || '').trim();
      return `节点 #${d.node_id || '?'}（${d.node_type || '节点'}）执行报错：${detail.slice(0, 220) || '未知错误'}`;
    }
  }
  return '节点执行报错，检查模型 / LoRA 名称是否存在、Custom Node 是否装齐';
}

/* ────────────────────────── 图片 ────────────────────────── */

function detectMime(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x52 && bytes[1] === 0x49) return 'image/webp';
  return '';
}

export function bytesToDataUrl(bytes, mime = '') {
  const type = mime || detectMime(bytes) || 'image/png';
  if (typeof Buffer !== 'undefined') {
    return `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
  }
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return `data:${type};base64,${btoa(binary)}`;
}

async function fetchImageBytes(t, info) {
  const qs = new URLSearchParams({
    filename: info.filename,
    subfolder: info.subfolder || '',
    type: info.type || 'output',
  });
  const res = await t.request(`/view?${qs.toString()}`, { method: 'GET' }, 60000);
  if (!res.ok) throw new ComfyError(`取图失败（HTTP ${res.status}）：${info.filename}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function fetchImageDataUrl(t, info) {
  const bytes = await fetchImageBytes(t, info);
  return bytesToDataUrl(bytes);
}

/* ────────────────────────── 主流程 ────────────────────────── */

/**
 * 提交并等待出图。
 * @returns {{promptId:string, images:Array, dataUrl:string, elapsedMs:number}}
 */
export async function runWorkflow(t, workflow, { timeoutMs = 600000, pollMs = 900, onTick, clientId } = {}) {
  const cid = clientId || `moss_${Math.random().toString(36).slice(2, 10)}`;
  const startedAt = Date.now();

  const submit = await getJson(
    t,
    '/prompt',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: cid }),
    },
    120000, // 显卡正忙 / 模型冷加载时，ComfyUI 的 /prompt 可能慢几十秒
  );
  if (!submit.ok) throw new ComfyError(formatSubmitError(submit.status, submit.json, submit.text), { stage: 'submit' });

  const promptId = submit.json?.prompt_id;
  if (!promptId) throw new ComfyError('ComfyUI 没返回 prompt_id', { stage: 'submit' });

  const deadline = startedAt + timeoutMs;
  let lastProgressTick = 0;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs));
    if (onTick && Date.now() - lastProgressTick > 1000) {
      lastProgressTick = Date.now();
      onTick({ elapsedMs: Date.now() - startedAt });
    }

    let hist;
    try {
      hist = await getJson(t, `/history/${encodeURIComponent(promptId)}`, { method: 'GET' }, 15000);
    } catch {
      continue; // 轮询偶发失败不算失败，下一轮接着问
    }
    if (!hist.ok || !hist.json) continue;
    const item = hist.json[promptId];
    if (!item) continue;

    if (item.status?.status_str === 'error') {
      throw new ComfyError(formatExecError(item), { stage: 'execute', promptId });
    }

    // 只认 output 类型的最终图，避开 HiresFix / FaceDetailer 产的 temp 中间预览
    const finalImgs = [];
    const tempImgs = [];
    for (const nodeOut of Object.values(item.outputs || {})) {
      if (!nodeOut || !Array.isArray(nodeOut.images)) continue;
      for (const im of nodeOut.images) {
        if (!im?.filename) continue;
        (im.type === 'output' || !im.type ? finalImgs : tempImgs).push(im);
      }
    }

    let picked = null;
    if (finalImgs.length) picked = finalImgs[finalImgs.length - 1];
    else if (tempImgs.length && (item.status?.completed === true || item.status?.status_str === 'success')) {
      picked = tempImgs[tempImgs.length - 1];
    } else if (item.status?.completed === true || item.status?.status_str === 'success') {
      throw new ComfyError('工作流跑完了但没有任何输出图：请确认有 SaveImage 或 PreviewImage 节点', { stage: 'execute', promptId });
    }
    if (!picked) continue;

    const dataUrl = await fetchImageDataUrl(t, picked);
    return {
      promptId,
      images: [...finalImgs, ...tempImgs],
      image: picked,
      dataUrl,
      elapsedMs: Date.now() - startedAt,
    };
  }

  throw new ComfyError(`等待出图超时（${Math.round(timeoutMs / 1000)} 秒）：ComfyUI 可能还在排队，或工作流里有高清修复很慢`, {
    stage: 'timeout',
    promptId,
  });
}

/**
 * 一步到位：检视 + 注入 + 提交 + 取图。
 * 这是给外部调用者（Android / 酒馆扩展 / 别的脚本）用的唯一入口。
 */
export async function generate(options) {
  const {
    base = DEFAULT_BASE,
    stProxy = true,
    workflow,
    positive = '',
    negative = '',
    seed = Math.floor(Math.random() * 4294967290) + 1,
    width = null,
    height = null,
    modelName = '',
    steps = null,
    cfg = null,
    samplerName = '',
    scheduler = '',
    overrideSampling = false,
    overrideSize = false,
    overrideModel = false,
    positiveNodeId = '',
    positiveMode = 'append',
    negativeNodeId = '',
    timeoutMs = 600000,
    onTick,
  } = options;

  const t = makeTransport({ base, stProxy });
  const hydrated = hydrateWorkflow(workflow, {
    positive, negative, seed, width, height, modelName,
    steps, cfg, samplerName, scheduler,
    overrideSampling, overrideSize, overrideModel,
    positiveNodeId, positiveMode, negativeNodeId,
  });
  const result = await runWorkflow(t, hydrated.workflow, { timeoutMs, onTick });
  return { ...result, seed: hydrated.seed, warnings: hydrated.warnings };
}
