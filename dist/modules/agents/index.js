"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.agentsModule = void 0;
const agentsModule = async (app) => {
    app.get('/', async (req) => ({
        module: 'agents',
        org_id: req.org_id,
        user_id: req.user_id,
        role: req.role,
    }));
};
exports.agentsModule = agentsModule;
