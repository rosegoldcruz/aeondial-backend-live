"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
exports.assertRequiredConfig = assertRequiredConfig;
require("dotenv/config");
exports.config = {
    nodeEnv: process.env.NODE_ENV || 'development',
    port: Number(process.env.PORT || 4000),
    jwtSecret: process.env.JWT_SECRET || '',
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    crmOrigin: process.env.CRM_ORIGIN || 'http://localhost:3000',
    aiWorkerOrigin: process.env.AI_WORKER_ORIGIN || 'http://localhost:8787',
    ariUrl: process.env.ARI_URL || '',
    ariUsername: process.env.ARI_USERNAME || '',
    ariPassword: process.env.ARI_PASSWORD || '',
    ariApp: process.env.ARI_APP || 'aeondial',
    ariEndpointPrefix: process.env.ARI_ENDPOINT_PREFIX || 'PJSIP',
    dialerOutboundEndpointTemplate: process.env.DIALER_OUTBOUND_ENDPOINT_TEMPLATE || `${process.env.ARI_ENDPOINT_PREFIX || 'PJSIP'}/{phone}@twilio-endpoint`,
    dialerAgentBeepMedia: process.env.DIALER_AGENT_BEEP_MEDIA || 'sound:beep',
    dialerWrapSeconds: Number(process.env.DIALER_WRAP_SECONDS || 15),
    dialerDefaultAgentEndpoint: process.env.DIALER_DEFAULT_AGENT_ENDPOINT || '',
    dialerDefaultAgentTransport: process.env.DIALER_DEFAULT_AGENT_TRANSPORT || 'udp',
    dialerDefaultAgentHost: process.env.DIALER_DEFAULT_AGENT_HOST || '',
};
function assertRequiredConfig() {
    if (!exports.config.supabaseUrl || !exports.config.supabaseServiceRoleKey) {
        throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    }
}
