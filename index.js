/**
 * st-moss-image —— 在聊天里用本地 ComfyUI 生成本轮对话的插画
 *
 * 触发：AI 在正文里写配图块 <photo title="…" kind="…">画面描述</photo>，
 *       前端把它换成「短标题 + 生图按钮」的卡片，点了才画（也可设成直接开画）
 * 提词：配图块里的描述 → 当前对话模型解析正文 → 离线词典，逐级兜底
 * 出图：把你的 API 工作流灌词 → 提交 ComfyUI → 轮询 → 取图
 * 落图：图片存 IndexedDB，聊天里只留一小段元数据（含 slot / title），
 *       重渲染时按槽位把图贴回原位
 *
 * 改代码前请先读同目录的 DEVELOPER.md —— 里面有必须保持的不变量。
 */

import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { getContext } from '../../../st-context.js';

import { inspectWorkflow, fetchServerInfo, generate, makeTransport, normalizeBaseUrl } from './lib/comfy-client.js';
import {
    parseControlTags, parseImageBlocks, buildPrompt, ruleExtract, parseWithLLM, cleanTagOutput,
} from './lib/prompt-pipeline.js';
import {
    putImage, getImage, deleteByChat, clearAll, usage,
} from './lib/image-store.js';
import { RenderQueue } from './lib/queue.js';
import { DEFAULT_WORKFLOW_JSON, DEFAULT_WORKFLOW_NAME } from './lib/workflow-default.js';

const MODULE = 'st-moss-image';

const SIZES = {
    p9x16: { width: 1088, height: 1920 },
    p2x3: { width: 832, height: 1216 },
    square: { width: 1024, height: 1024 },
    w16x9: { width: 1920, height: 1088 },
    w3x2: { width: 1216, height: 832 },
};

const DEFAULTS = {
    enabled: true,
    base: 'http://127.0.0.1:8188',
    stProxy: true,
    workflows: [],
    activeWorkflowId: '',
    positiveNodeId: '',
    positiveMode: 'replace',
    negativeNodeId: '',
    negativeText: '',
    overrideSize: false,
    overrideModel: false,
    modelName: '',
    overrideSampling: false,
    steps: 8,
    cfg: 1,
    samplerName: 'euler',
    scheduler: 'simple',
    size: 'p9x16',
    trigger: 'card',
    parse: 'model',
    llmMode: 'natural',
    prefix: '',
    identity: '',
    suffix: '',
    caption: true,
    intervalSec: 1.5,
    timeoutSec: 600,
};

const state = {
    server: null,
    inspect: null,
    urls: new Map(),
    missing: new Set(),
    inflight: new Set(),
    lastConnectFailed: false,
};

const $id = (id) => document.getElementById(id);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ══════════════════ 设置读写 ══════════════════ */

function getSettings() {
    if (!extension_settings[MODULE]) extension_settings[MODULE] = {};
    const s = extension_settings[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined) s[k] = structuredClone(v);
    }
    if (!Array.isArray(s.workflows) || s.workflows.length === 0) {
        s.workflows = [{ id: 'wf_moss', name: DEFAULT_WORKFLOW_NAME, json: DEFAULT_WORKFLOW_JSON }];
    }
    if (!s.workflows.some(w => w.id === s.activeWorkflowId)) s.activeWorkflowId = s.workflows[0].id;
    // 老版本 trigger 的取值是 tag / keyword，v2 改成 card / auto / off
    if (s.trigger === 'tag' || s.trigger === 'keyword') s.trigger = 'card';
    if (!['card', 'auto', 'off'].includes(s.trigger)) s.trigger = 'card';
    // v2 迁移：解析输出默认从 Danbooru 标签换成中文自然语言。
    // 老配置里存着的 tags 几乎都是当年默认值（没人主动选过），一并迁过来。
    if (s.__v === undefined) {
        s.__v = 2;
        if (s.llmMode === 'tags') s.llmMode = 'natural';
    }
    return s;
}

const settings = () => getSettings();

function save() {
    saveSettingsDebounced();
}

function getWorkflow() {
    const s = settings();
    return s.workflows.find(w => w.id === s.activeWorkflowId) || s.workflows[0] || null;
}

/* ══════════════════ 设置界面 ══════════════════ */

async function buildSettingsPanel() {
    // 酒馆在某些情况下会把扩展激活两次；没有这道闸就会append两份面板，
    // 于是 getElementById 拿到的是前一份（status 永远停在初始值），后面全乱。
    if ($id('moss-enabled')) return;
    const url = new URL('./settings.html', import.meta.url);
    const html = await (await fetch(url)).text();
    $('#extensions_settings2').append(html);
    fillSettingsUI();
    bindSettingsUI();
    refreshInspect();
    refreshStoreStatus();
}

function fillSettingsUI() {
    const s = settings();
    $id('moss-enabled').checked = s.enabled;
    $id('moss-base').value = s.base;
    $id('moss-stproxy').checked = s.stProxy;
    $id('moss-pos-mode').value = s.positiveMode;
    $id('moss-neg-text').value = s.negativeText;
    $id('moss-override-size').checked = s.overrideSize;
    $id('moss-override-model').checked = s.overrideModel;
    $id('moss-model').value = s.modelName;
    $id('moss-override-sampling').checked = s.overrideSampling;
    $id('moss-steps').value = s.steps;
    $id('moss-cfg').value = s.cfg;
    $id('moss-size').value = s.size;
    $id('moss-trigger').value = s.trigger;
    $id('moss-parse').value = s.parse;
    $id('moss-llm-mode').value = s.llmMode;
    $id('moss-prefix').value = s.prefix;
    $id('moss-identity').value = s.identity;
    $id('moss-suffix').value = s.suffix;
    $id('moss-caption').checked = s.caption;
    $id('moss-interval').value = s.intervalSec;
    $id('moss-timeout').value = s.timeoutSec;
    renderWorkflowSelect();
    fillSamplerSelects();
    updateSamplingDisabled();
}

function bindSettingsUI() {
    const bind = (id, key, read = (el) => el.value) => {
        $id(id).addEventListener('change', () => {
            settings()[key] = read($id(id));
            save();
        });
    };
    const bindCheck = (id, key) => {
        $id(id).addEventListener('change', () => {
            settings()[key] = $id(id).checked;
            save();
            if (key === 'overrideSampling') updateSamplingDisabled();
        });
    };

    bindCheck('moss-enabled', 'enabled');
    bind('moss-base', 'base');
    bindCheck('moss-stproxy', 'stProxy');
    bind('moss-pos-mode', 'positiveMode');
    bind('moss-neg-text', 'negativeText');
    bindCheck('moss-override-size', 'overrideSize');
    bindCheck('moss-override-model', 'overrideModel');
    bind('moss-model', 'modelName');
    bindCheck('moss-override-sampling', 'overrideSampling');
    bind('moss-steps', 'steps', el => Number(el.value) || 8);
    bind('moss-cfg', 'cfg', el => Number(el.value) || 1);
    bind('moss-sampler', 'samplerName');
    bind('moss-scheduler', 'scheduler');
    bind('moss-size', 'size');
    bind('moss-trigger', 'trigger');
    bind('moss-llm-mode', 'llmMode');
    bind('moss-prefix', 'prefix');
    bind('moss-identity', 'identity');
    bind('moss-suffix', 'suffix');
    bindCheck('moss-caption', 'caption');
    bind('moss-interval', 'intervalSec', el => Number(el.value) || 0);
    bind('moss-timeout', 'timeoutSec', el => Math.max(30, Number(el.value) || 600));

    $id('moss-parse').addEventListener('change', () => {
        settings().parse = $id('moss-parse').value;
        save();
    });

    $id('moss-pos-node').addEventListener('change', () => {
        settings().positiveNodeId = $id('moss-pos-node').value;
        save();
    });
    $id('moss-neg-node').addEventListener('change', () => {
        settings().negativeNodeId = $id('moss-neg-node').value;
        save();
    });

    $id('moss-connect').addEventListener('click', () => connect());

    $id('moss-wf').addEventListener('change', () => {
        settings().activeWorkflowId = $id('moss-wf').value;
        save();
        refreshInspect();
    });

    $id('moss-wf-import').addEventListener('click', () => $id('moss-wf-file').click());
    $id('moss-wf-file').addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        addWorkflow(file.name.replace(/\.json$/i, ''), await file.text());
        e.target.value = '';
    });
    $id('moss-wf-paste-add').addEventListener('click', () => {
        const text = $id('moss-wf-paste').value.trim();
        if (!text) return toast('粘贴框是空的', 'bad');
        const name = $id('moss-wf-paste-name').value.trim() || `工作流 ${settings().workflows.length + 1}`;
        if (addWorkflow(name, text)) $id('moss-wf-paste').value = '';
    });
    $id('moss-wf-del').addEventListener('click', () => {
        const s = settings();
        if (s.workflows.length <= 1) return toast('至少留一个工作流', 'bad');
        const wf = getWorkflow();
        if (!confirm(`删除工作流「${wf.name}」？`)) return;
        s.workflows = s.workflows.filter(w => w.id !== wf.id);
        s.activeWorkflowId = s.workflows[0].id;
        save();
        renderWorkflowSelect();
        refreshInspect();
    });

    $id('moss-refresh-models').addEventListener('click', () => connect());

    $id('moss-clear-chat').addEventListener('click', async () => {
        const ctx = getContext();
        const chatId = ctx.getCurrentChatId();
        if (!chatId) return toast('现在不在聊天里', 'bad');
        if (!confirm('删掉本聊天所有插画？聊天文字不受影响。')) return;
        const n = await deleteByChat(chatId);
        for (const m of ctx.chat) {
            if (m?.extra?.mossImages) delete m.extra.mossImages;
        }
        await ctx.saveChat();
        resetImageDom();
        refreshStoreStatus();
        toast(`删掉 ${n} 张`, 'ok');
    });

    $id('moss-clear-all').addEventListener('click', async () => {
        if (!confirm('清空全部缓存图片？所有聊天里的插画都会消失。')) return;
        await clearAll();
        resetImageDom();
        refreshStoreStatus();
        toast('已清空', 'ok');
    });
}

/**
 * 清完缓存后的收尾：作废 blob URL、清空各种状态、把 DOM 里的图摘掉，
 * 再让配图块重新变回「生图」按钮 —— 否则会留下一堆点不动的空位。
 */
function resetImageDom() {
    for (const url of state.urls.values()) URL.revokeObjectURL(url);
    state.urls.clear();
    state.missing.clear();
    document.querySelectorAll('.moss-figs').forEach(el => el.remove());
    document.querySelectorAll('#chat .mes[mesid]').forEach((el) => {
        const mesId = Number(el.getAttribute('mesid'));
        if (Number.isFinite(mesId)) renderCards(mesId);
    });
}

function updateSamplingDisabled() {
    const on = settings().overrideSampling;
    for (const id of ['moss-steps', 'moss-cfg', 'moss-sampler', 'moss-scheduler']) {
        if ($id(id)) $id(id).disabled = !on;
    }
}

function renderWorkflowSelect() {
    const sel = $id('moss-wf');
    if (!sel) return;
    sel.innerHTML = '';
    for (const wf of settings().workflows) {
        const opt = document.createElement('option');
        opt.value = wf.id;
        opt.textContent = wf.name;
        sel.append(opt);
    }
    sel.value = settings().activeWorkflowId;
}

function fillSamplerSelects() {
    const s = settings();
    const samplers = state.server?.samplers?.length ? state.server.samplers : ['euler', 'euler_ancestral', 'dpmpp_2m', 'dpmpp_2m_sde'];
    const schedulers = state.server?.schedulers?.length ? state.server.schedulers : ['simple', 'normal', 'karras', 'beta'];
    const fill = (node, list, cur) => {
        if (!node) return;
        node.innerHTML = '';
        for (const v of list) node.append(new Option(v, v));
        if (cur && !list.includes(cur)) node.append(new Option(cur, cur));
        node.value = cur || list[0];
    };
    fill($id('moss-sampler'), samplers, s.samplerName);
    fill($id('moss-scheduler'), schedulers, s.scheduler);
}

function refreshInspect() {
    const wf = getWorkflow();
    const box = $id('moss-wf-summary');
    if (!wf || !box) return;
    const info = inspectWorkflow(wf.json);
    state.inspect = info;

    if (!info.ok) {
        box.innerHTML = `<span class="bad">${escapeHtml(info.error)}</span>`;
        if (info.isCanvasFormat) box.append(escapeHtml('　导出方式：ComfyUI 设置 → 勾 Enable Dev mode Options → 菜单 Workflow → Export (API)。'));
        return;
    }

    const rows = [];
    rows.push(`节点 ${info.nodeCount} 个 · 模型 <code>${escapeHtml(info.model || '未识别')}</code>`);
    if (info.size) rows.push(`工作流尺寸 ${info.size.width}×${info.size.height}`);
    if (info.inferred) rows.push(`采样 ${info.inferred.steps ?? '?'} 步 · cfg ${info.inferred.cfg ?? '?'} · ${escapeHtml(info.inferred.samplerName || '?')}`);
    rows.push(`正面节点 ${info.positiveTargets.map(t => `#${t.id}`).join('、') || '未识别'}`);
    rows.push(`负面 ${info.zeroNeg ? '被零化（这个工作流不用负面词）' : (info.negativeTargets.map(t => `#${t.id}`).join('、') || '无')}`);
    // 负面被零化这件事上面一行已经说过了，warning 里再重复一遍只是噪音
    const warns = (info.warnings || []).filter(w => !(info.zeroNeg && /ConditioningZeroOut|零化/.test(w)));
    box.innerHTML = rows.map(r => `<div>${r}</div>`).join('')
        + warns.map(w => `<div class="warn">⚠ ${escapeHtml(w)}</div>`).join('');

    const nodes = info.textNodes || [];
    const pos = $id('moss-pos-node');
    const neg = $id('moss-neg-node');
    if (pos) {
        pos.innerHTML = '';
        pos.append(new Option(info.positiveTargets.length ? '自动识别（推荐）' : '自动识别（没找到，手动选）', ''));
        for (const t of nodes) pos.append(new Option(`#${t.id} ${t.title}${t.preview ? ` · ${t.preview.slice(0, 20)}` : ''}`, t.id));
        const cur = settings().positiveNodeId;
        pos.value = nodes.some(t => t.id === cur) ? cur : '';
    }
    if (neg) {
        neg.innerHTML = '';
        neg.append(new Option('不写入（保持工作流原样）', ''));
        for (const t of nodes) neg.append(new Option(`#${t.id} ${t.title}`, t.id));
        const cur = settings().negativeNodeId;
        neg.value = nodes.some(t => t.id === cur) ? cur : '';
    }
}

function addWorkflow(name, jsonText) {
    const info = inspectWorkflow(jsonText);
    if (!info.ok) {
        toast(info.error, 'bad');
        return false;
    }
    const s = settings();
    const wf = { id: `wf_${Date.now().toString(36)}`, name: name || '未命名', json: jsonText };
    s.workflows.push(wf);
    s.activeWorkflowId = wf.id;
    save();
    renderWorkflowSelect();
    refreshInspect();
    toast(`已加入「${wf.name}」`, 'ok');
    return true;
}

/* ══════════════════ 连接 ══════════════════ */

/**
 * 提前把连接焐热。
 *
 * 浏览器对 ComfyUI 端口的第一条连接要等很久（见下面 connect 的注释）。
 * 这里用 no-cors 发一条最轻的请求把它提前开出来——no-cors 不受 CORS 限制，
 * 一定能打通 TCP，之后真正的 /system_stats 就是在一条已建立的连接上跑，毫秒级。
 *
 * 只开一次：多条并发冷连接不会更快，反而每个都要各等一遍。
 */
let warmPromise = null;
let warmBase = '';
function warmupSocket(base, timeoutMs = 120000) {
    if (warmPromise && warmBase === base) return warmPromise;
    warmBase = base;
    let url = '';
    try { url = normalizeBaseUrl(base); } catch { return Promise.resolve(); }
    warmPromise = Promise.race([
        fetch(`${url}/`, { mode: 'no-cors', cache: 'no-store' }).catch(() => { }),
        sleep(timeoutMs),
    ]);
    return warmPromise;
}

/**
 * 连 ComfyUI。
 *
 * 有个坑必须说清楚：浏览器对 ComfyUI 那个端口的**第一条连接**在这台机器上会被拖到
 * 9~70 秒（curl 只要 4 毫秒，换个干净配置的浏览器也一样），连上之后都是个位数毫秒。
 * 所以这里不做"超时就重试"——abort 掉会变成又一次全新的冷连接，越试越慢。
 * 改成：一次给足 120 秒，状态栏显示已经等了多少秒，让用户知道它在干活而不是卡死。
 */
async function connect() {
    const s = settings();
    const status = $id('moss-conn-status');
    let phase = '连接中…';
    let tick = 0;
    const setStatus = (text, cls = 'moss-status') => {
        if (!status) return;
        status.className = cls;
        status.textContent = text;
    };
    const started = Date.now();
    clearInterval(tick);
    const paint = () => {
        const sec = Math.round((Date.now() - started) / 1000);
        setStatus(sec >= 5 ? `${phase}（已等 ${sec} 秒，首次连接会慢，之后就快了）` : phase);
    };
    paint();
    tick = setInterval(paint, 1000);

    try {
        // 预热只是"占个位"，最多等 15 秒就走了——别让预热把真正要用的连接也拖住
        await warmupSocket(s.base, 15000);
        phase = '正在连接 ComfyUI…';
        paint();
        const info = await fetchServerInfo(
            makeTransport({ base: s.base, stProxy: s.stProxy }),
            { onStep: (text) => { phase = text; paint(); } },
        );
        state.server = info;
        setStatus([
            `ComfyUI ${info.version || ''}`,
            info.device || '',
            `UNET ${info.unets.length}`,
            `LoRA ${info.loras.length}`,
            `Checkpoint ${info.ckpts.length}`,
        ].filter(Boolean).join(' · '), 'moss-status ok');
        const list = $id('moss-model-list');
        if (list) {
            list.innerHTML = '';
            for (const m of [...info.unets, ...info.ckpts]) list.append(new Option(m));
        }
        fillSamplerSelects();
        // 上次没连上时弹过报错，这次成功了就把旧提示收掉，别让用户以为还坏着
        if (state.lastConnectFailed) toast('连接成功', 'ok');
        state.lastConnectFailed = false;
        return true;
    } catch (e) {
        state.server = null;
        state.lastConnectFailed = true;
        setStatus(e.message, 'moss-status bad');
        console.warn('[moss] 连接失败：', e.message);
        return false;
    } finally {
        clearInterval(tick);
    }
}

/* ══════════════════ 大模型解析 ══════════════════ */

function makeLlmCall() {
    return async (system, user) => {
        const ctx = getContext();
        if (typeof ctx.generateQuietPrompt !== 'function') throw new Error('当前酒馆版本不支持静默生成');
        const prompt = `${system}\n\n${user}\n\n(只输出结果本身，不要解释、不要角色扮演、不要加引号)`;
        const out = await ctx.generateQuietPrompt({
            quietPrompt: prompt,
            quietToLoud: false,
            skipWIAN: true,
            responseLength: 220,
            removeReasoning: true,
        });
        return out;
    };
}

/* ══════════════════ 出图 ══════════════════ */

const queue = new RenderQueue({
    intervalMs: 1500,
    onChange: () => { },
    run: (job) => doGenerate(job),
});

function currentQueueIntervalMs() {
    return Math.max(0, Number(settings().intervalSec) || 0) * 1000;
}

function resolveSize() {
    const s = settings();
    if (s.overrideSize && SIZES[s.size]) return { ...SIZES[s.size], override: true };
    return { width: null, height: null, override: false };
}

async function decideTags(job) {
    const s = settings();

    // 1. AI 自己在 <photo> 里写了 tags —— 最准，直接用
    if (job.tags && job.tags.trim()) {
        return { tags: job.tags.trim(), from: 'tag' };
    }
    // 2. 只用标签模式：没标签就不该走到这里，兜底词典
    if (s.parse === 'tag') {
        return { tags: ruleExtract(job.story).tags.join(', '), from: 'dict' };
    }
    // 3. 当前对话模型解析
    if (s.parse === 'model') {
        try {
            const out = await parseWithLLM({
                text: job.story,
                kind: job.kind,
                mode: s.llmMode,
                llmCall: makeLlmCall(),
            });
            const cleaned = s.llmMode === 'natural' ? out : sanitizeTags(out);
            if (cleaned) return { tags: cleaned, from: 'model' };
        } catch (e) {
            console.warn('[moss] 模型解析失败，退回词典：', e);
        }
    }
    // 4. 离线词典
    return { tags: ruleExtract(job.story).tags.join(', '), from: 'dict' };
}

/**
 * 静默生成偶尔会跑成角色扮演，吐一大段中文。
 * 只保留纯 ASCII 的逗号片段，凑够 3 个才认，否则交给词典。
 */
function sanitizeTags(raw) {
    if (!raw) return '';
    const cleaned = cleanTagOutput(raw, { asciiOnly: true });
    const segs = cleaned
        .split(',')
        .map(s => s.trim().replace(/^["'「『]|["'」』]$/g, ''))
        .filter(s => s && s.length <= 60);
    return segs.length >= 3 ? segs.join(', ') : '';
}

function dataUrlToBlob(dataUrl) {
    const [head, b64] = String(dataUrl).split(',');
    const mime = (head.match(/data:([^;]+)/) || [, 'image/png'])[1];
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
}

function measure(dataUrl) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => resolve({ width: null, height: null });
        img.src = dataUrl;
    });
}

async function doGenerate(job) {
    const s = settings();
    const wf = getWorkflow();
    if (!wf) throw localFail('没有可用工作流，去设置里导入');
    const info = inspectWorkflow(wf.json);
    if (!info.ok) throw localFail(info.error);

    const slot = typeof job.slot === 'number' ? job.slot : null;
    // 有槽位：状态挂在卡片上，占位条不参与；没槽位：楼层末尾挂一条
    const fig = slot === null ? showPlaceholder(job.mesId, '准备中…') : null;
    const note = (text) => {
        if (slot !== null) setSlot(job.mesId, slot, 'loading', text);
        else setFigNote(fig, text);
    };
    note('准备中…');

    const started = Date.now();
    try {
        /*
         * 三段来源：AI 自己写在配图块里的 prompt（最准）→ 模型解析 → 离线词典。
         * 不管哪一段，最后都要套上用户设的前缀 / 人物外观 / 后缀 ——
         * 这是跨轮保持同一张脸的关键，不能被"AI 已经写好了"跳过。
         */
        let core = String(job.prompt || '').trim();
        let from = core ? (job.final ? 'reuse' : 'block') : '';
        if (!core) {
            const decided = await decideTags(job);
            from = decided.from;
            core = String(decided.tags || '').trim();
        }
        if (!core) throw localFail('这条消息里没提取到可用提示词，换个解析方式，或直接在配图块里写画面描述');

        // 换一张时传进来的已经是拼好的最终提示词，别再套一遍前缀（会重复）
        const prompt = job.final ? core : buildPrompt({
            prefix: s.prefix,
            identity: s.identity,
            tags: core,
            suffix: s.suffix,
            natural: /[\u4e00-\u9fff]/.test(core),
        });

        note('渲染中… 0s');

        const size = resolveSize();
        const seed = Math.floor(Math.random() * 4294967290) + 1;
        const res = await generate({
            base: s.base,
            stProxy: s.stProxy,
            workflow: wf.json,
            positive: prompt,
            negative: s.negativeText,
            seed,
            width: size.width,
            height: size.height,
            modelName: s.modelName,
            steps: s.steps,
            cfg: s.cfg,
            samplerName: s.samplerName,
            scheduler: s.scheduler,
            overrideSampling: s.overrideSampling,
            overrideSize: size.override,
            overrideModel: s.overrideModel,
            positiveNodeId: s.positiveNodeId,
            positiveMode: s.positiveMode,
            negativeNodeId: s.negativeNodeId,
            timeoutMs: s.timeoutSec * 1000,
            onTick: ({ elapsedMs }) => note(`渲染中… ${Math.round(elapsedMs / 1000)}s`),
        });

        for (const w of res.warnings || []) {
            if (/没能自动定位|负面被零化/.test(w)) console.info('[moss]', w);
        }

        const blob = dataUrlToBlob(res.dataUrl);
        const real = await measure(res.dataUrl);
        const meta = {
            id: `${job.chatId}:${job.mesId}:${Date.now()}`,
            prompt,
            seed: res.seed,
            width: real.width,
            height: real.height,
            kind: job.kind || 'selfie',
            createdAt: Date.now(),
            workflow: wf.name,
            from,
        };
        if (slot !== null) {
            meta.slot = slot;
            if (job.title) meta.title = job.title;
        }
        await putImage({
            id: meta.id,
            blob,
            chatId: job.chatId,
            mesId: job.mesId,
            prompt,
            seed: meta.seed,
            width: meta.width,
            height: meta.height,
            workflowName: wf.name,
            elapsedMs: res.elapsedMs,
        });

        await attachMetaToMessage(job.mesId, meta);
        finalizeSlot(job.mesId, meta, URL.createObjectURL(blob));
        refreshStoreStatus();
        return res;
    } catch (e) {
        const msg = e.message || String(e);
        if (slot !== null) setSlot(job.mesId, slot, 'failed', `没画成：${msg}`);
        else failPlaceholder(fig, msg, job);
        throw e;
    }
}

function localFail(msg) {
    const err = new Error(msg);
    err.localOnly = true;
    return err;
}

async function attachMetaToMessage(mesId, meta) {
    const ctx = getContext();
    const mes = ctx.chat?.[mesId];
    if (!mes) return;
    mes.extra = mes.extra && typeof mes.extra === 'object' ? mes.extra : {};
    if (!Array.isArray(mes.extra.mossImages)) mes.extra.mossImages = [];
    mes.extra.mossImages.push(meta);
    try {
        await ctx.saveChat();
    } catch (e) {
        console.warn('[moss] 保存聊天失败', e);
    }
}

/* ══════════════════ 聊天 DOM ══════════════════ */

/**
 * 消息节点。
 *
 * 注意：酒馆 1.13 的 .mes 元素**没有 id**（别再写 #message0，那是不存在的），
 * 唯一可靠的锚点是 mesid 属性。
 */
function mesElOf(mesId) {
    return document.querySelector(`#chat .mes[mesid="${Number(mesId)}"]`);
}

function blockOf(mesId) {
    // 系统消息 / 部分精简渲染下没有 .mes_block，退回整个 .mes，别让图无处可放直接丢掉
    const el = mesElOf(mesId);
    return el ? (el.querySelector('.mes_block') || el) : null;
}

/** 只查不建：这层已经有 .moss-figs 容器了吗 */
function existingFigs(mesId) {
    return blockOf(mesId)?.querySelector(':scope > .moss-figs') || null;
}

function figsOf(mesId) {
    const block = blockOf(mesId);
    if (!block) {
        console.warn('[moss] 找不到消息容器，出图结果无法显示：mesid', mesId);
        return null;
    }
    let wrap = block.querySelector(':scope > .moss-figs');
    if (!wrap) {
        wrap = document.createElement('div');
        wrap.className = 'moss-figs';
        wrap.dataset.mossFor = String(mesId);
        block.append(wrap);
    }
    return wrap;
}

/**
 * 没有槽位的生成（楼层右侧那个手动按钮）的视觉反馈。
 *
 * 有 `<photo>` 块的消息一律走卡片，这里只在「这条消息没写配图块」时用：
 * 在容器末尾挂一条占位条，出图后由 attachImagesToMessage 换成图。
 */
function showPlaceholder(mesId, text) {
    const wrap = figsOf(mesId);
    if (!wrap) return null;
    wrap.querySelector('.moss-fig.loading')?.remove();
    const fig = el('span', 'moss-fig loading');
    fig.append(el('span', 'moss-spinner'), el('span', 'moss-card-note', text));
    wrap.append(fig);
    return fig;
}

function setFigNote(fig, text) {
    if (!fig || !fig.isConnected) return;
    const note = fig.querySelector('.moss-card-note');
    if (note && note.textContent !== text) note.textContent = text;
}

/** 无槽位生成失败：把那条占位条就地改成失败态，带重试 */
function failPlaceholder(fig, message, job) {
    if (!fig || !fig.isConnected) {
        console.warn('[moss] 生成失败：', message);
        return;
    }
    fig.classList.remove('loading');
    fig.classList.add('failed');
    fig.querySelector('.moss-spinner')?.remove();
    const note = fig.querySelector('.moss-card-note');
    if (note) note.textContent = `没画成：${message}`;
    const retry = el('a', null, '重试');
    retry.addEventListener('click', () => {
        fig.remove();
        enqueue(job.mesId, {
            kind: job.kind, tags: job.tags, story: job.story, prompt: job.prompt, reason: 'retry',
        });
    });
    fig.append(retry);
    console.warn('[moss] 生成失败：', message);
}

/**
 * 入队。
 *
 * slot 是消息内配图块的序号（parseImageBlocks 给的），有 slot 就按"卡片"反馈，
 * 没 slot 就是手动按钮那条老路（末尾占位条）。
 */
function enqueue(mesId, { slot = null, kind = 'selfie', tags = '', story = '', prompt = '', title = '', reason = '', final = false } = {}) {
    const s = settings();
    if (!s.enabled) return;
    const key = typeof slot === 'number' ? slotKey(mesId, slot) : null;
    // 同一楼可能有好几张配图卡片，互不阻塞：按槽位记，没有槽位才按楼层记
    const ticket = key || `m:${mesId}`;
    if (state.inflight.has(ticket)) {
        console.info('[moss] 这块正在生成中，跳过');
        return;
    }
    const ctx = getContext();
    const chatId = ctx.getCurrentChatId() || 'unknown';
    queue.intervalMs = currentQueueIntervalMs();
    state.inflight.add(ticket);
    if (key) setSlot(mesId, slot, 'loading', '排队中…');
    const { promise } = queue.enqueue({
        mesId, chatId, slot, kind, tags, story, prompt, title, reason, final,
    });
    promise
        .catch(() => { /* 错误已经在卡片里显示了 */ })
        .finally(() => {
            state.inflight.delete(ticket);
            // 正常结束（成功/失败）时槽位状态已被 doGenerate 处理；
            // 还剩 loading 的说明是被取消了，别让卡片永远转圈
            if (key && slotState.get(key)?.phase === 'loading') {
                slotState.delete(key);
                renderCards(mesId);
            }
        });
}

function openLightbox(url, meta) {
    const box = document.createElement('div');
    box.className = 'moss-lightbox';
    const img = document.createElement('img');
    img.src = url;
    const bar = document.createElement('div');
    bar.className = 'moss-lightbox-bar';
    bar.textContent = meta?.prompt || '';
    box.append(img, bar);
    box.addEventListener('click', () => box.remove());
    document.body.append(box);
}

/* ══════════════════ 配图卡片 ══════════════════ */

/**
 * 设计要点（改之前先读这段）
 *
 * 1. **不动 mes.mes**。提示词原文留在聊天记录里，模型下一轮还能看到，
 *    视觉锚点（发色/瞳色/配饰）才能跨轮保持一致。只在前端把它藏起来。
 * 2. 藏的办法：酒馆渲染后 `<photo title="X">提示词</photo>` 会变成一段干净的正文，
 *    我们就按"提示词原文"精确找到那段文字，把它换成卡片。不依赖标签是否存活。
 * 3. 每块有 slot 序号，出过的图按 slot 记住，重绘时直接放图而不是再放按钮。
 */

const slotState = new Map(); // `${mesId}:${slot}` → { phase: 'loading'|'failed', note }
const slotKey = (mesId, slot) => `${mesId}:${slot}`;

/** 改某块的状态并立刻重绘这一楼（只重绘一次，避免频繁 DOM 抖动） */
function setSlot(mesId, slot, phase, note = '') {
    if (typeof slot !== 'number') return;
    const key = slotKey(mesId, slot);
    if (phase) slotState.set(key, { phase, note });
    else slotState.delete(key);
    renderCards(mesId);
}

function messageItems(mes) {
    if (!mes?.mes) return [];
    return parseImageBlocks(mes.mes).items;
}

function imagesBySlot(mes) {
    const out = new Map();
    for (const meta of mes?.extra?.mossImages || []) {
        if (typeof meta.slot === 'number') out.set(meta.slot, meta);
    }
    return out;
}

function mesTextOf(mesId) {
    return mesElOf(mesId)?.querySelector('.mes_text') || null;
}

function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
}

/** 在消息正文里找这段提示词落在哪个文本节点上 */
function findAnchor(root, prompt) {
    const probe = String(prompt || '');
    if (!probe) return null;
    const shortNeedle = probe.slice(0, Math.min(24, probe.length));
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement?.closest('.moss-card, .moss-fig, .moss-figs')
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT),
    });
    let node;
    while ((node = walker.nextNode())) {
        const text = node.nodeValue || '';
        let idx = text.indexOf(probe);
        let len = probe.length;
        if (idx < 0 && shortNeedle.length >= 8) {
            idx = text.indexOf(shortNeedle);
            len = Math.min(probe.length, text.length - idx);
        }
        if (idx >= 0) return { node, start: idx, end: Math.min(idx + len, text.length) };
    }
    return null;
}

function figureFor(mesId, meta, url) {
    const fig = el('span', 'moss-fig');
    fig.dataset.mossId = meta.id;
    fig.dataset.mossKind = 'fig';
    if (typeof meta.slot === 'number') fig.dataset.mossSlot = String(meta.slot);

    const img = document.createElement('img');
    img.src = url;
    img.alt = meta.title || meta.prompt || '';
    img.loading = 'lazy';
    img.addEventListener('click', () => openLightbox(url, meta));
    fig.append(img);

    if (settings().caption) {
        const cap = el('span', 'moss-fig-cap');
        const info = el('span', 'moss-fig-info', [
            meta.title ? `【${meta.title}】` : '',
            meta.seed != null ? `种子 ${meta.seed}` : '',
            meta.width ? `${meta.width}×${meta.height}` : '',
        ].filter(Boolean).join(' · '));
        const actions = el('span', 'moss-fig-actions');
        const again = el('a', null, '换一张');
        again.addEventListener('click', (e) => {
            e.stopPropagation();
            enqueue(mesId, {
                slot: meta.slot, kind: meta.kind, prompt: meta.prompt, title: meta.title, reason: 'again', final: true,
            });
        });
        const down = el('a', null, '下载');
        down.addEventListener('click', () => {
            const a = document.createElement('a');
            a.href = url;
            a.download = `moss_${meta.seed || Date.now()}.png`;
            a.click();
        });
        actions.append(again, down);
        cap.append(info, actions);
        fig.append(cap);
    }
    return fig;
}

function cardFor(mesId, item) {
    const card = el('span', 'moss-card');
    card.dataset.mossSlot = String(item.slot);
    card.dataset.mossKind = 'card';
    card.append(el('span', 'moss-card-title', item.title || `配图 ${item.slot + 1}`));
    const btn = el('button', 'moss-card-btn', '生图');
    btn.type = 'button';
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        btn.disabled = true;
        enqueue(mesId, {
            slot: item.slot, kind: item.kind, prompt: item.prompt, title: item.title, reason: 'card',
        });
    });
    card.append(btn);
    return card;
}

function loadingCardFor(item, note) {
    const card = el('span', 'moss-card loading');
    card.dataset.mossSlot = String(item.slot);
    card.dataset.mossKind = 'loading';
    card.append(el('span', 'moss-spinner'), el('span', 'moss-card-title', item.title || `配图 ${item.slot + 1}`));
    card.append(el('span', 'moss-card-note', note || '排队中…'));
    return card;
}

function failedCardFor(mesId, item, note) {
    const card = el('span', 'moss-card failed');
    card.dataset.mossSlot = String(item.slot);
    card.dataset.mossKind = 'failed';
    card.append(el('span', 'moss-card-title', item.title || `配图 ${item.slot + 1}`));
    card.append(el('span', 'moss-card-note', note || '没画成'));
    const retry = el('a', null, '重试');
    retry.addEventListener('click', (e) => {
        e.stopPropagation();
        enqueue(mesId, {
            slot: item.slot, kind: item.kind, prompt: item.prompt, title: item.title, reason: 'retry',
        });
    });
    card.append(retry);
    return card;
}

/** 把元素放到提示词原本所在的位置；整段就是提示词的话连 <p> 一起换掉 */
function placeAt(root, item, node) {
    const anchor = findAnchor(root, item.prompt);
    if (!anchor) return false;
    const { node: textNode, start, end } = anchor;
    const textLen = (textNode.nodeValue || '').length;
    const wholeNode = start === 0 && end >= textLen;
    const parent = textNode.parentElement;
    const ownLine = wholeNode && parent && /^(P|DIV)$/.test(parent.tagName) && parent.childNodes.length === 1;

    if (ownLine) {
        node.classList.add('moss-own-line');
        parent.replaceWith(node);
        return true;
    }
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, end);
    range.deleteContents();
    range.insertNode(node);
    return true;
}

/** Grok 多行格式会在正文里留下 image### 残片和一个空的 <h3 id="photo"> */
function cleanArtifacts(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const dirty = [];
    let node;
    while ((node = walker.nextNode())) {
        if (node.parentElement?.closest('.moss-card, .moss-fig')) continue;
        if (/image\s*#{3,}|#{3,}/i.test(node.nodeValue || '')) dirty.push(node);
    }
    for (const n of dirty) {
        n.nodeValue = (n.nodeValue || '')
            .replace(/image\s*#{3,}\s*/gi, '')
            .replace(/\s*#{3,}\s*/g, ' ')
            .replace(/[ \t]{2,}/g, ' ');
    }
    root.querySelectorAll('p, h1, h2, h3, h4, h5, h6, div').forEach((e) => {
        if (e.querySelector('.moss-card, .moss-fig, img')) return;
        if (!e.textContent.trim() && !e.querySelector('br')) e.remove();
    });
}

/** 把这一楼里所有配图块渲染成「卡片或图」。幂等，可以反复调。 */
function renderCards(mesId) {
    const ctx = getContext();
    const mes = ctx.chat?.[mesId];
    if (!mes || !settings().enabled) return;
    const root = mesTextOf(mesId);
    if (!root) return;

    const items = messageItems(mes);
    if (!items.length) return;
    const bySlot = imagesBySlot(mes);

    for (const item of items) {
        const meta = bySlot.get(item.slot);
        const st = slotState.get(slotKey(mesId, item.slot));
        let desired;
        let kind;
        if (meta) {
            const url = state.urls.get(meta.id);
            if (!url) {
                if (!state.missing.has(meta.id)) continue; // blob 还在取，等 ensureUrls 之后再来
                // 图确实没了（缓存被清过），别让提示词原文裸露在正文里
                desired = failedCardFor(mesId, item, '这张图已不在本地缓存');
                kind = 'failed';
            } else {
                desired = figureFor(mesId, meta, url);
                kind = 'fig';
            }
        } else if (st?.phase === 'loading') {
            desired = loadingCardFor(item, st.note);
            kind = 'loading';
        } else if (st?.phase === 'failed') {
            desired = failedCardFor(mesId, item, st.note);
            kind = 'failed';
        } else {
            desired = cardFor(mesId, item);
            kind = 'card';
        }

        const current = mesElOf(mesId)?.querySelector(`.moss-card[data-moss-slot="${item.slot}"], .moss-fig[data-moss-slot="${item.slot}"]`);

        if (current) {
            if (current.dataset.mossKind === kind) {
                // 同为「画图中」，只改文案，别把节点整个换掉（会重复触发 observer）
                const note = current.querySelector('.moss-card-note');
                if (note && st?.note && note.textContent !== st.note) note.textContent = st.note;
                continue;
            }
            current.replaceWith(desired);
            continue;
        }
        if (!placeAt(root, item, desired)) {
            (existingFigs(mesId) || figsOf(mesId))?.append(desired);
        }
    }
    cleanArtifacts(root);
}

/** 把 IndexedDB 里的图取成 blob URL，供 renderCards 直接用 */
async function ensureUrls(mesId) {
    const ctx = getContext();
    const mes = ctx.chat?.[mesId];
    let loaded = 0;
    for (const meta of mes?.extra?.mossImages || []) {
        if (!meta?.id || state.urls.has(meta.id) || state.missing.has(meta.id)) continue;
        try {
            const rec = await getImage(meta.id);
            if (!rec?.blob) {
                // 记下来，别在每次 DOM 变动时都回 IndexedDB 里空找一遍
                state.missing.add(meta.id);
                console.info('[moss] 图片本体已不在本地缓存里：', meta.id);
                continue;
            }
            state.urls.set(meta.id, URL.createObjectURL(rec.blob));
            loaded += 1;
        } catch (e) {
            state.missing.add(meta.id);
            console.warn('[moss] 读取缓存失败', e);
        }
    }
    return loaded;
}

/* ══════════════════ 事件 ══════════════════ */

function onCharacterMessage(mesId) {
    const ctx = getContext();
    const mes = ctx.chat?.[mesId];
    if (!mes || mes.is_user || mes.is_system) return;
    const s = settings();
    if (!s.enabled || s.trigger === 'off') return;

    const items = messageItems(mes);
    if (!items.length) return;

    if (s.trigger === 'auto') {
        for (const it of items) {
            enqueue(mesId, {
                slot: it.slot, kind: it.kind, prompt: it.prompt, title: it.title, reason: 'auto',
            });
        }
        return;
    }
    renderCards(mesId);
}

function guessKindFromStory(text) {
    return /私密|私房|福利|内衣|裸|浴室|床上|睡衣/i.test(text) ? 'private' : 'selfie';
}

/**
 * 出图收尾：有槽位的清掉槽位状态、重绘卡片；没槽位的仍挂在楼层末尾。
 * url 由调用方建好并塞进 state.urls，renderCards 直接取。
 */
function finalizeSlot(mesId, meta, url) {
    if (!meta?.id) return;
    if (url && !state.urls.has(meta.id)) state.urls.set(meta.id, url);
    if (typeof meta.slot === 'number') {
        slotState.delete(slotKey(mesId, meta.slot));
        renderCards(mesId);
        return;
    }
    const wrap = figsOf(mesId);
    if (!wrap) return;
    wrap.querySelector('.moss-fig.loading')?.remove();
    if (wrap.querySelector(`[data-moss-id="${CSS.escape(meta.id)}"]`)) return;
    wrap.append(figureFor(mesId, meta, url));
}

function attachImagesToMessage(mesId) {
    const ctx = getContext();
    const mes = ctx.chat?.[mesId];
    const metas = (mes?.extra?.mossImages || []).filter(m => typeof m.slot !== 'number');
    if (!metas.length) return;
    const wrap = figsOf(mesId);
    if (!wrap) return;
    for (const meta of metas) {
        if (wrap.querySelector(`[data-moss-id="${CSS.escape(meta.id)}"]`)) continue;
        const url = state.urls.get(meta.id);
        if (!url) continue;
        wrap.append(figureFor(mesId, meta, url));
    }
}

function addManualButton(root = document) {
    if (!settings().enabled) return 0;
    let added = 0;
    root.querySelectorAll('#chat .mes[mesid]').forEach((el) => {
        const mesId = Number(el.getAttribute('mesid'));
        const isUser = el.getAttribute('is_user') === 'true';
        const isSystem = el.getAttribute('is_system') === 'true';
        if (isUser || isSystem || !Number.isFinite(mesId)) return;
        if (el.querySelector('.moss-gen-btn')) return;
        const holder = el.querySelector('.extraMesButtons') || el.querySelector('.mes_buttons');
        if (!holder) return;
        const btn = document.createElement('div');
        btn.className = 'mes_button moss-gen-btn fa-solid fa-wand-magic-sparkles';
        btn.title = '用这条消息画一张';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const mes = getContext().chat?.[mesId];
            if (!mes) return;
            const parsed = parseControlTags(mes.mes);
            enqueue(mesId, {
                kind: parsed.photo?.kind || guessKindFromStory(parsed.cleanText),
                tags: parsed.photo?.tags || '',
                story: parsed.cleanText,
                reason: 'manual',
            });
        });
        holder.prepend(btn);
        added += 1;
    });
    return added;
}

/** 有没有哪层该挂按钮却没挂（用来避免在每次 DOM 变动时做无用功） */
function needsButtons() {
    for (const el of document.querySelectorAll('#chat .mes[mesid]')) {
        if (el.getAttribute('is_user') === 'true') continue;
        if (el.getAttribute('is_system') === 'true') continue;
        if (!el.querySelector('.moss-gen-btn')) return true;
    }
    return false;
}

/**
 * 盯住 #chat。
 *
 * 只在启动时 setTimeout 挂按钮是不够的：酒馆渲染聊天是异步的，
 * 定时器经常早于消息进 DOM，结果一个按钮都挂不上。
 * 换成 MutationObserver 后，新消息、翻页、swipe 重绘都能补上，
 * 酒馆重绘整块 .mes_block 时被冲掉的按钮也会自动补回来。
 */
let chatObserver = null;
let chatTarget = null;
let btnTimer = 0;
function watchChat() {
    const chat = document.getElementById('chat');
    if (!chat) { setTimeout(watchChat, 500); return; }
    if (chatObserver && chatTarget === chat) return;
    if (chatObserver) chatObserver.disconnect();
    chatTarget = chat;
    addManualButton();
    chatObserver = new MutationObserver(() => {
        clearTimeout(btnTimer);
        btnTimer = setTimeout(() => {
            if (needsButtons()) addManualButton();
            attachAll();
        }, 200);
    });
    chatObserver.observe(chat, { childList: true, subtree: true });
}

/**
 * 把落在聊天记录里的图重新贴回 DOM。
 *
 * 只处理"有元数据但 DOM 里还没画"的层，代价很低，
 * 所以可以放心地在 DOM 每次变动后都跑一遍——这是首屏能补上图的唯一可靠时机：
 * 扩展注册 CHAT_CHANGED 时，聊天往往已经渲染完了，那个事件根本收不到。
 */
async function attachAll() {
    const ctx = getContext();
    const jobs = [];
    document.querySelectorAll('#chat .mes[mesid]').forEach((el) => {
        const mesId = Number(el.getAttribute('mesid'));
        if (!Number.isFinite(mesId)) return;
        const mes = ctx.chat?.[mesId];
        if (!mes) return;
        const metas = mes.extra?.mossImages;
        const hasBlocks = messageItems(mes).length > 0;
        if ((!Array.isArray(metas) || !metas.length) && !hasBlocks) return;
        jobs.push(applyMessage(mesId));
    });
    await Promise.all(jobs);
    addManualButton();
}

/** 单层收尾：取图 → 画卡片 → 贴老式图片（没有槽位的历史数据） */
async function applyMessage(mesId) {
    await ensureUrls(mesId);
    renderCards(mesId);
    attachImagesToMessage(mesId);
}

function onChatChanged() {
    // 切聊天时 blob URL 全作废；slotState 的键带 mesId，换聊天后不会撞车，
    // 但留着没意义，一并清掉
    for (const url of state.urls.values()) URL.revokeObjectURL(url);
    state.urls.clear();
    state.missing.clear();
    state.inflight.clear();
    slotState.clear();
    setTimeout(attachAll, 600);
    watchChat();
    setTimeout(refreshStoreStatus, 200);
}

async function refreshStoreStatus() {
    const el = $id('moss-store-status');
    if (!el) return;
    try {
        const { count, bytes } = await usage();
        el.textContent = `本地缓存 ${count} 张 · ${(bytes / 1024 / 1024).toFixed(1)} MB`;
    } catch {
        el.textContent = '—';
    }
}

/* ══════════════════ 小工具 ══════════════════ */

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer = 0;
function toast(msg, kind = '') {
    let el = $id('moss-toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'moss-toast';
        el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:99999;'
            + 'padding:8px 14px;border-radius:9px;font-size:12.5px;color:#fff;background:#333;'
            + 'box-shadow:0 6px 20px rgba(0,0,0,.28);transition:opacity .2s;';
        document.body.append(el);
    }
    el.textContent = msg;
    el.style.background = kind === 'bad' ? '#8a1f18' : kind === 'ok' ? '#2f7d4f' : '#333';
    el.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 2600);
}

/* ══════════════════ 启动 ══════════════════ */

jQuery(async () => {
    getSettings();
    // 先把连接焐热，再建面板：冷连接那几十秒和建面板并行，用户少等一会儿
    warmupSocket(settings().base);
    await buildSettingsPanel();

    const ctx = getContext();
    const ev = ctx.eventSource;
    const types = ctx.eventTypes;

    ev.on(types.MESSAGE_RECEIVED, (mesId) => {
        onCharacterMessage(Number(mesId));
    });

    ev.on(types.CHARACTER_MESSAGE_RENDERED, (mesId) => {
        const id = Number(mesId);
        addManualButton();
        applyMessage(id);
    });

    ev.on(types.MESSAGE_SWIPED, (mesId) => {
        setTimeout(() => { addManualButton(); applyMessage(Number(mesId)); }, 120);
    });

    ev.on(types.MESSAGE_EDITED, (mesId) => {
        setTimeout(() => {
            addManualButton();
            const id = Number(mesId);
            if (Number.isFinite(id)) applyMessage(id);
        }, 120);
    });

    ev.on(types.CHAT_CHANGED, onChatChanged);

    watchChat();
    setTimeout(attachAll, 800);
    connect();

    // 调试口子：控制台里可以 __moss.enqueue(mesId, {...}) 手动触发一次，
    // 排查问题时不用每次都去点按钮
    window.__moss = {
        settings, enqueue, state, queue, refreshInspect, attachAll, addManualButton,
        watchChat, connect, handleMessage: onCharacterMessage,
    };

    console.log('[moss] 扩展已加载');
});
