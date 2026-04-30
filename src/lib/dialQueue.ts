import { Queue } from 'bullmq';
import { redis } from './redis.js';

const DIAL_QUEUE = 'dial-queue';

export const dialQueue = new Queue(DIAL_QUEUE, {
  connection: redis,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});
