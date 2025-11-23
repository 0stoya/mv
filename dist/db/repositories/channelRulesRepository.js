"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getChannelRuleByChannel = getChannelRuleByChannel;
exports.getAllChannelRules = getAllChannelRules;
exports.upsertChannelRule = upsertChannelRule;
const knex_1 = require("../knex");
async function getChannelRuleByChannel(channel) {
    return (0, knex_1.db)('channel_rules')
        .where({ channel })
        .andWhere({ is_active: 1 })
        .first();
}
async function getAllChannelRules() {
    return (0, knex_1.db)('channel_rules')
        .select('*')
        .orderBy('channel', 'asc');
}
async function upsertChannelRule(params) {
    const existing = await (0, knex_1.db)('channel_rules')
        .where({ channel: params.channel })
        .first();
    if (existing) {
        await (0, knex_1.db)('channel_rules')
            .where({ id: existing.id })
            .update({
            auto_invoice: params.autoInvoice ? 1 : 0,
            auto_ship: params.autoShip ? 1 : 0,
            is_active: params.isActive ? 1 : 0,
            updated_at: knex_1.db.fn.now()
        });
    }
    else {
        await (0, knex_1.db)('channel_rules').insert({
            channel: params.channel,
            auto_invoice: params.autoInvoice ? 1 : 0,
            auto_ship: params.autoShip ? 1 : 0,
            is_active: params.isActive ? 1 : 0
        });
    }
}
