import { Queue } from "bullmq";
import { Redis } from "ioredis";

export const redisConnection = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export const queue = new Queue("file-upload-queue", {
  connection: redisConnection,
}); // A queue named "file-upload-queue" is created in Valkey running on localhost:6379.

await queue.obliterate({ force: true });
