import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const QUEUE_PREFIX = process.env.QUEUE_PREFIX || "anime-canvas";
const IMAGE_CONCURRENCY = Number(process.env.IMAGE_QUEUE_CONCURRENCY || 2);
const queueOptions = {
  defaultJobOptions: {
    attempts: Number(process.env.TASK_RETRY_ATTEMPTS || 2),
    backoff: { type: "exponential", delay: Number(process.env.TASK_RETRY_DELAY_MS || 3000) },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
};

let imageQueue;
let imageWorker;
let redisReady = false;
let localRunner = null;

function createRedisConnection() {
  return new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
  });
}

export async function initializeTaskQueue(processTask) {
  localRunner = processTask;
  if (process.env.TASK_QUEUE_MODE === "local") return { mode: "local" };

  const connection = createRedisConnection();
  try {
    await connection.connect();
    await connection.ping();
  } catch (error) {
    await connection.quit().catch(() => {});
    console.warn(`任务队列使用本地回退：${error instanceof Error ? error.message : String(error)}`);
    return { mode: "local" };
  }

  redisReady = true;
  imageQueue = new Queue(`${QUEUE_PREFIX}:image`, { connection, ...queueOptions });
  imageWorker = new Worker(
    `${QUEUE_PREFIX}:image`,
    async (job) => processTask(job.data.taskId),
    { connection: createRedisConnection(), concurrency: IMAGE_CONCURRENCY },
  );
  imageWorker.on("failed", (job, error) => {
    console.warn(`任务 ${job?.data?.taskId || job?.id} 执行失败：${error.message}`);
  });

  return { mode: "bullmq" };
}

export async function enqueueTask(task) {
  if (redisReady && imageQueue && task.type === "image.generate") {
    await imageQueue.add(task.type, { taskId: task.id }, {
      jobId: task.id,
      priority: Number(task.priority || 5),
    });
    return { mode: "bullmq" };
  }

  if (localRunner) queueMicrotask(() => localRunner(task.id));
  return { mode: "local" };
}

export async function closeTaskQueue() {
  await imageWorker?.close();
  await imageQueue?.close();
}
