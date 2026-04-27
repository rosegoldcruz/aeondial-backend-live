"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.automationsModule = void 0;
const automationsModule = async (app) => {
    app.get('/', async (req) => ({
        module: 'automations',
        org_id: req.org_id,
        user_id: req.user_id,
        role: req.role,
    }));
};
exports.automationsModule = automationsModule;
