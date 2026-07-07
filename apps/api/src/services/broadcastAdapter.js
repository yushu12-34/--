// 广播适配器：抽象跨实例消息分发。
// - 默认：单进程内存广播（当前行为，无外部依赖）
// - REDIS_URL 设置时：通过 Redis Pub/Sub 跨实例广播，支持多 API 实例横向扩展
//
// 设计要点：
// 1. 本地广播仍由 collaborationService 直接完成（保留 exceptSocket 排除语义）
// 2. 适配器仅负责"跨实例"部分：本地广播后，publish 到 Redis 频道
// 3. 其他实例 subscribe 后，调用本地广播函数把消息投递给本实例的客户端
// 4. exceptSocket 在跨实例场景下无意义（发送方不在本实例），因此远端广播给全部本地客户端

let adapter = null;
let localBroadcastFn = null;

/**
 * 注册本地广播函数。collaborationService 启动时调用。
 * @param {(canvasId: string, payload: object, exceptSocketId?: string) => void} fn
 */
export function setLocalBroadcast(fn) {
  localBroadcastFn = fn;
}

/**
 * 获取广播适配器。首次调用时惰性初始化。
 * @returns {BroadcastAdapter}
 */
export function getBroadcastAdapter() {
  if (adapter) return adapter;
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    adapter = createRedisAdapter(redisUrl);
  } else {
    adapter = createInMemoryAdapter();
  }
  return adapter;
}

/**
 * In-memory 适配器：单进程模式，publish 为 no-op。
 * 本地 broadcast 已覆盖所有客户端，无需跨实例分发。
 */
function createInMemoryAdapter() {
  return {
    async publish() {
      // no-op: 单进程，本地广播已足够
    },
    async close() {
      // no-op
    },
  };
}

/**
 * Redis 适配器：通过 Redis Pub/Sub 跨实例广播。
 * 需要 ioredis 依赖（npm install ioredis）。未安装时降级为内存模式。
 */
function createRedisAdapter(redisUrl) {
  let publisher = null;
  let subscriber = null;
  let ready = false;

  const init = async () => {
    if (ready) return;
    let Redis;
    try {
      const mod = await import("ioredis");
      Redis = mod.default || mod;
    } catch {
      console.warn("[broadcastAdapter] REDIS_URL set but ioredis not installed. Falling back to in-memory mode. Run: npm --prefix apps/api install ioredis");
      adapter = createInMemoryAdapter();
      return;
    }
    publisher = new Redis(redisUrl, { maxRetriesPerRequest: 3, lazyConnect: false });
    subscriber = new Redis(redisUrl, { maxRetriesPerRequest: 3, lazyConnect: false });
    subscriber.on("message", (_channel, data) => {
      try {
        const { canvasId, payload } = JSON.parse(data);
        if (localBroadcastFn && canvasId && payload) {
          // 远端消息：广播给本实例所有客户端（发送方不在本实例，无需排除）
          localBroadcastFn(canvasId, payload);
        }
      } catch (error) {
        console.warn("[broadcastAdapter] failed to handle redis message:", error?.message || error);
      }
    });
    ready = true;
    console.log("[broadcastAdapter] Redis pub/sub enabled for cross-instance broadcast");
  };

  const channelName = (canvasId) => `anime_canvas:collab:${canvasId}`;

  return {
    async publish(canvasId, payload) {
      if (!ready) await init();
      if (!publisher || adapter !== this) return; // 降级后跳过
      try {
        await publisher.publish(channelName(canvasId), JSON.stringify({ canvasId, payload }));
      } catch (error) {
        console.warn("[broadcastAdapter] redis publish failed:", error?.message || error);
      }
    },
    async close() {
      if (subscriber) await subscriber.quit().catch(() => {});
      if (publisher) await publisher.quit().catch(() => {});
      ready = false;
    },
  };
}
