// stats.js — 按访问令牌（= 每个朋友）累计用量统计。
//
// 只存「每令牌聚合」(count + anlas + lastAt)，体量 = 朋友数，不会无限增长；
// 不保留逐条任务列表（那才会撑大内存）。逐条账本走 server 的 stdout `usage` 日志，
// 由 Render 日志自带留存 / 滚动，长期对账看日志即可。
//
// Render 免费档重启 / 休眠会把本聚合清零（属正常）；要按账期手动清零调 reset()（/stats/reset）。
export class UsageStats {
  constructor() {
    this.since = Date.now();
    this.byToken = new Map();
  }

  record(token, anlas) {
    const key = token || '(unknown)';
    const e = this.byToken.get(key) || { count: 0, anlas: 0, lastAt: 0 };
    e.count += 1;
    e.anlas += Number(anlas) || 0;
    e.lastAt = Date.now();
    this.byToken.set(key, e);
  }

  snapshot() {
    const tokens = {};
    let count = 0;
    let anlas = 0;
    for (const [k, e] of this.byToken) {
      tokens[k] = { count: e.count, anlas: e.anlas, lastAt: e.lastAt };
      count += e.count;
      anlas += e.anlas;
    }
    return { since: this.since, totals: { count, anlas }, tokens };
  }

  reset() {
    this.since = Date.now();
    this.byToken.clear();
  }
}
