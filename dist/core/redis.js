"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.workflowsQueue = exports.actionsQueue = exports.triggersQueue = exports.bullConnection = exports.redis = void 0;
exports.startBackgroundWorkers = startBackgroundWorkers;
const ioredis_1 = __importDefault(require("ioredis"));
const bullmq_1 = require("bullmq");
const config_1 = require("./config");
const logger_1 = require("./logger");
exports.redis = new ioredis_1.default(config_1.config.redisUrl, {
    maxRetriesPerRequest: null,
});
exports.bullConnection = { url: config_1.config.redisUrl };
exports.triggersQueue = new bullmq_1.Queue('triggers', {
    connection: exports.bullConnection,
});
exports.actionsQueue = new bullmq_1.Queue('actions', {
    connection: exports.bullConnection,
});
exports.workflowsQueue = new bullmq_1.Queue('workflows', {
    connection: exports.bullConnection,
});
const allowedTriggers = new Set([
    'call.ended',
    'sms.received',
    'lead.created',
    'lead.updated',
    'ai.outcome',
]);
const allowedActions = new Set([
    'send.sms',
    'send.email',
    'assign.agent',
    'move.pipeline',
    'start.campaign',
    'fire.webhook',
]);
let workersStarted = false;
function startBackgroundWorkers() {
    if (workersStarted) {
        return;
    }
    workersStarted = true;
    const triggersWorker = new bullmq_1.Worker('triggers', async (job) => {
        if (!allowedTriggers.has(job.name)) {
            throw new Error(`Unsupported trigger: ${job.name}`);
        }
        const payload = (job.data || {});
        if (!payload.org_id) {
            throw new Error('Trigger job missing org_id');
        }
        logger_1.logger.info({ trigger: job.name, org_id: payload.org_id }, 'Trigger received');
        // Fan out actions declared by the workflow payload.
        for (const action of payload.actions || []) {
            await exports.actionsQueue.add(action, { ...payload, source_trigger: job.name });
        }
    }, { connection: exports.bullConnection });
    const actionsWorker = new bullmq_1.Worker('actions', async (job) => {
        if (!allowedActions.has(job.name)) {
            throw new Error(`Unsupported action: ${job.name}`);
        }
        const payload = (job.data || {});
        if (!payload.org_id) {
            throw new Error('Action job missing org_id');
        }
        logger_1.logger.info({ action: job.name, org_id: payload.org_id }, 'Action executed');
    }, { connection: exports.bullConnection });
    const workflowsWorker = new bullmq_1.Worker('workflows', async (job) => {
        const payload = (job.data || {});
        if (!payload.org_id || !payload.trigger) {
            throw new Error('Workflow job missing org_id or trigger');
        }
        await exports.triggersQueue.add(payload.trigger, {
            org_id: payload.org_id,
            actions: payload.actions || [],
        });
        logger_1.logger.info({ workflow: job.name, org_id: payload.org_id, trigger: payload.trigger }, 'Workflow enqueued trigger');
    }, { connection: exports.bullConnection });
    for (const worker of [triggersWorker, actionsWorker, workflowsWorker]) {
        worker.on('failed', (job, err) => {
            logger_1.logger.error({ queue: worker.name, jobId: job?.id, err }, 'Worker job failed');
        });
    }
    logger_1.logger.info('BullMQ workers started: triggers, actions, workflows');
}
