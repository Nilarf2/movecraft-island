// 账号存档同步：一次只发一个请求，只保留最新的一份；网络失败隔几秒重试；409 冲突以服务器为准。
// 换人（reset）以后，上一个人还没发出去的存档直接丢弃，绝不写进下一个人的账号。
const RETRY_MS = 5000;
const islandOf = latest => latest && typeof latest === 'object' && 'data' in latest ? latest.data : latest;

export function createSaves({api, onConflict, onNotice}) {
  let userId = null, pending = null, inflight = null, timer = 0, warned = false;
  const idleWaiters = new Set();
  const settleIdle = () => { if (!pending && !inflight) { for (const resolve of idleWaiters) resolve(); idleWaiters.clear(); } };

  async function pump() {
    if (inflight || !pending || !api?.storeSave) { settleIdle(); return; }
    const job = pending; pending = null;
    inflight = job;
    try {
      await api.storeSave(job.island);
      if (warned && job.user === userId) { warned = false; onNotice?.('存档已同步到服务器。', 'info'); }
    } catch (error) {
      if (job.user !== userId) { /* the player left; their unsent progress stays on the server as it was */ }
      else if (error?.code === 'conflict') { pending = null; onConflict?.(islandOf(error.latest)); }
      else if (error?.code === 'auth') { pending = null; onNotice?.('登录已过期，这一轮的进度没能保存。', 'warn'); }
      else if (error?.code === 'invalid' || error?.code === 'rejected') { pending = null; onNotice?.('服务器不接受这份存档，本轮不再保存。', 'warn'); }
      else {
        pending ??= job;
        if (!warned) { warned = true; onNotice?.('存档暂时没有同步，会自动重试。', 'warn'); }
        clearTimeout(timer); timer = setTimeout(pump, RETRY_MS);
      }
    } finally { inflight = null; }
    if (pending && !timer) pump();
    else settleIdle();
  }
  return {
    reset(id) { userId = id ?? null; pending = null; warned = false; clearTimeout(timer); timer = 0; },
    save(user, island) {
      if (!api?.storeSave || !user || (user.id ?? user.username) !== userId) return;
      pending = {user: userId, island};
      clearTimeout(timer); timer = 0;
      pump();
    },
    // Waits (up to ms) for the last save before the account is logged out.
    drain(ms = 4000) {
      if (!pending && !inflight) return Promise.resolve();
      return Promise.race([new Promise(resolve => idleWaiters.add(resolve)), new Promise(resolve => setTimeout(resolve, ms))]);
    },
  };
}
