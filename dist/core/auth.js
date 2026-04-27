"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authPlugin = void 0;
exports.requireTenantContext = requireTenantContext;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const supabase_1 = require("./supabase");
const config_1 = require("./config");
const logger_1 = require("./logger");
const authPlugin = async (app) => {
    app.decorateRequest('org_id', '');
    app.decorateRequest('user_id', '');
    app.decorateRequest('role', '');
    app.addHook('onRequest', async (req) => {
        const authHeader = req.headers.authorization;
        const bearer = authHeader?.startsWith('Bearer ')
            ? authHeader.slice('Bearer '.length)
            : undefined;
        let claims = {};
        if (bearer) {
            try {
                if (config_1.config.jwtSecret) {
                    claims = jsonwebtoken_1.default.verify(bearer, config_1.config.jwtSecret);
                }
                else {
                    claims = jsonwebtoken_1.default.decode(bearer) || {};
                }
            }
            catch {
                // Fall through to header-based extraction.
            }
        }
        req.org_id =
            claims.org_id ||
                req.headers['x-org-id'] ||
                undefined;
        req.user_id =
            claims.user_id ||
                req.headers['x-user-id'] ||
                undefined;
        req.role =
            claims.role ||
                req.headers['x-role'] ||
                undefined;
    });
};
exports.authPlugin = authPlugin;
const PUBLIC_PATHS = new Set(['/health', '/version', '/ws']);
const INTERNAL_CALLBACK_PATHS = [
    /^\/dialer\/calls\/[^/]+\/amd_result$/,
];
const VALID_ROLES = new Set(['owner', 'admin', 'agent']);
const AGENT_WRITE_ALLOWLIST = [
    /^\/dialer\/agents\/session$/,
    /^\/dialer\/agents\/[^/]+\/state$/,
    /^\/dialer\/calls\/[^/]+\/disposition$/,
    /^\/telephony\/calls\/end$/,
];
function extractScopedOrgId(req) {
    const query = (req.query || {});
    const body = (req.body || {});
    const params = (req.params || {});
    const candidates = [
        query.org_id,
        query.orgId,
        body.org_id,
        body.orgId,
        params.org_id,
        params.orgId,
    ];
    const scoped = candidates.find((value) => typeof value === 'string');
    return scoped;
}
function isWriteMethod(method) {
    return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}
function isAgentWriteAllowed(path) {
    return AGENT_WRITE_ALLOWLIST.some((pattern) => pattern.test(path));
}
function bypassTenantContext(path) {
    return PUBLIC_PATHS.has(path) || INTERNAL_CALLBACK_PATHS.some((pattern) => pattern.test(path));
}
function firstHeaderValue(value) {
    if (Array.isArray(value)) {
        const candidate = value.find((entry) => typeof entry === 'string' && entry.trim());
        return candidate?.trim();
    }
    if (typeof value === 'string' && value.trim()) {
        return value.trim();
    }
    return undefined;
}
async function ensureOrgExists(req, reply) {
    const { data: org, error } = await supabase_1.supabase
        .from('orgs')
        .select('org_id')
        .eq('org_id', req.org_id)
        .maybeSingle();
    if (error) {
        await reply.status(500).send({ error: error.message });
        return false;
    }
    if (org) {
        return true;
    }
    const orgSlug = firstHeaderValue(req.headers['x-org-slug']) || null;
    const orgName = firstHeaderValue(req.headers['x-org-name']) || orgSlug || req.org_id || 'Unknown organization';
    const { error: bootstrapError } = await supabase_1.supabase
        .from('orgs')
        .upsert({
        org_id: req.org_id,
        name: orgName,
        status: 'active',
        metadata: {
            identity_provider: 'clerk',
            bootstrap_source: 'auth.requireTenantContext',
            clerk: {
                org_id: req.org_id,
                org_slug: orgSlug,
            },
        },
        created_by: req.user_id,
        updated_by: req.user_id,
        updated_at: new Date().toISOString(),
    }, { onConflict: 'org_id' });
    if (bootstrapError) {
        logger_1.logger.error({ err: bootstrapError, org_id: req.org_id, user_id: req.user_id }, 'Failed to auto-bootstrap org scope');
        await reply.status(500).send({ error: bootstrapError.message });
        return false;
    }
    logger_1.logger.info({ org_id: req.org_id, user_id: req.user_id, org_slug: orgSlug }, 'Auto-bootstrapped org from authenticated scope');
    return true;
}
async function requireTenantContext(req, reply) {
    const path = req.url.split('?')[0];
    if (bypassTenantContext(path)) {
        return;
    }
    if (!req.org_id) {
        await reply.status(401).send({ error: 'Missing org_id in JWT or header' });
        return;
    }
    if (!req.role || !VALID_ROLES.has(req.role)) {
        await reply.status(403).send({ error: 'Invalid or missing role' });
        return;
    }
    // Enforce role-based write restrictions.
    if (isWriteMethod(req.method) && req.role === 'agent' && !path.startsWith('/ai')) {
        if (!isAgentWriteAllowed(path)) {
            await reply.status(403).send({ error: 'Agent role cannot perform write operations on this resource' });
            return;
        }
    }
    if (!(await ensureOrgExists(req, reply))) {
        return;
    }
    // Reject cross-tenant attempts when route payload/query includes org_id.
    const scopedOrgId = extractScopedOrgId(req);
    if (scopedOrgId && scopedOrgId !== req.org_id) {
        await reply.status(403).send({ error: 'Cross-tenant access denied' });
        return;
    }
}
