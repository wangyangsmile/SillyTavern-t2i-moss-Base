/**
 * queue.js —— 串行生图队列
 *
 * 移植自角色卡 04 号的 processRenderQueueLoop（3352–3417）。
 * 原版有两套间隔：NovelAI 60 秒防封、ComfyUI 2 秒。这里只剩后者，
 * 但保留了一个关键行为 —— 「请求根本没发出去」的失败不占用冷却时间。
 */

export class RenderQueue {
  /**
   * @param {object} opts
   * @param {number} opts.intervalMs 两次提交之间的最小间隔
   * @param {(job:object)=>Promise<any>} opts.run 真正的执行函数
   * @param {(state:object)=>void} opts.onChange 状态变化回调
   */
  constructor({ intervalMs = 1500, run, onChange = () => {} } = {}) {
    this.intervalMs = intervalMs;
    this.run = run;
    this.onChange = onChange;
    this.items = [];
    this.running = false;
    this.lastSubmitAt = 0;
    this.seq = 0;
    this._emit();
  }

  get waiting() {
    return this.items.filter(i => i.status === 'queued').length;
  }

  get active() {
    return this.items.filter(i => i.status === 'queued' || i.status === 'running');
  }

  /** 冷却还剩多少毫秒 */
  get cooldownLeft() {
    if (!this.lastSubmitAt) return 0;
    return Math.max(0, this.lastSubmitAt + this.intervalMs - Date.now());
  }

  enqueue(spec) {
    const job = { id: `job_${++this.seq}`, status: 'queued', spec, createdAt: Date.now(), error: null };
    this.items.push(job);
    const promise = new Promise((resolve, reject) => {
      job._resolve = resolve;
      job._reject = reject;
    });
    this._emit();
    this._loop();
    return { job, promise };
  }

  cancel(id) {
    const job = this.items.find(i => i.id === id);
    if (!job || job.status !== 'queued') return false;
    job.status = 'canceled';
    job._reject?.(new Error('已取消'));
    this._emit();
    return true;
  }

  clearDone() {
    this.items = this.active;
    this._emit();
  }

  _emit() {
    this.onChange({
      items: this.items,
      waiting: this.waiting,
      active: this.active.length,
      cooldownLeft: this.cooldownLeft,
    });
  }

  async _loop() {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const job = this.items.find(i => i.status === 'queued');
        if (!job) break;

        const wait = this.cooldownLeft;
        if (wait > 0) {
          await new Promise(r => setTimeout(r, Math.min(400, wait)));
          continue;
        }

        const prevSubmitAt = this.lastSubmitAt;
        job.status = 'running';
        this.lastSubmitAt = Date.now();
        this._emit();

        try {
          const result = await this.run(job.spec, job);
          job.status = 'done';
          job._resolve?.(result);
        } catch (err) {
          job.status = 'error';
          job.error = err?.message || String(err);
          // 本地校验就失败的（没发请求）不占用冷却，原版也是这个逻辑
          if (err?.localOnly) this.lastSubmitAt = prevSubmitAt;
          job._reject?.(err);
        } finally {
          this._emit();
        }
      }
    } finally {
      this.running = false;
      this._emit();
    }
  }
}
