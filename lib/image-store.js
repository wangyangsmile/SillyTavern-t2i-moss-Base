/**
 * image-store.js —— 图片存本地 IndexedDB
 *
 * 为什么不塞进聊天的 JSON：一张 1088×1920 的 PNG 转 base64 有 2-3 MB，
 * 聊到几十楼能把聊天文件撑到上百 MB，酒馆保存/加载都会变慢。
 * 所以聊天里只留 { id, prompt, seed, createdAt } 这么一小段元数据，
 * 图片本体按 id 存在 IndexedDB 里，重渲染时再贴回来。
 */

const DB_NAME = 'st-moss-image';
const DB_VERSION = 1;
const STORE = 'images';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const idb = globalThis.indexedDB;
    if (!idb) return reject(new Error('浏览器不支持 IndexedDB'));
    const guard = setTimeout(() => reject(new Error('图片库打开超时')), 5000);
    const req = idb.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('chatId', 'chatId');
      }
    };
    req.onsuccess = () => {
      clearTimeout(guard);
      const db = req.result;
      db.onversionchange = () => { try { db.close(); } catch { /* ignore */ } dbPromise = null; };
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { clearTimeout(guard); reject(req.error || new Error('打不开图片库')); };
  }).catch((e) => { dbPromise = null; throw e; });
  return dbPromise;
}

function tx(mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let out;
    try {
      out = fn(store);
    } catch (e) {
      reject(e);
      return;
    }
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export async function putImage({ id, blob, chatId, mesId, prompt = '', seed = null, width = null, height = null, workflowName = '', elapsedMs = null }) {
  const rec = {
    id,
    chatId: chatId || '',
    mesId: mesId ?? null,
    blob,
    prompt,
    seed,
    width,
    height,
    workflowName,
    elapsedMs,
    createdAt: Date.now(),
  };
  await tx('readwrite', store => store.put(rec));
  return rec;
}

export async function getImage(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readonly');
    const req = t.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteImage(id) {
  await tx('readwrite', store => store.delete(id));
}

export async function deleteByChat(chatId) {
  const db = await openDb();
  const keys = await new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readonly');
    const req = t.objectStore(STORE).index('chatId').getAllKeys(chatId);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  await tx('readwrite', (store) => { keys.forEach(k => store.delete(k)); });
  return keys.length;
}

export async function clearAll() {
  await tx('readwrite', store => store.clear());
}

/** 占用统计：条数与字节数 */
export async function usage() {
  const db = await openDb();
  const all = await new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readonly');
    const req = t.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  const bytes = all.reduce((n, r) => n + (r.blob?.size || 0), 0);
  return { count: all.length, bytes };
}
