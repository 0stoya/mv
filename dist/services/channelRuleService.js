"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveChannelRule = resolveChannelRule;
const channelRulesRepository_1 = require("../db/repositories/channelRulesRepository");
const channelRules_1 = require("../config/channelRules");
async function resolveChannelRule(channel) {
    const channelKey = channel || '';
    // 1) Try DB rule
    if (channelKey) {
        const dbRule = await (0, channelRulesRepository_1.getChannelRuleByChannel)(channelKey);
        if (dbRule) {
            return {
                autoInvoice: !!dbRule.auto_invoice,
                autoShip: !!dbRule.auto_ship
            };
        }
    }
    // 2) Fallback to static config
    if (channelKey && channelRules_1.CHANNEL_RULES[channelKey]) {
        return channelRules_1.CHANNEL_RULES[channelKey];
    }
    // 3) Fallback to default
    return channelRules_1.DEFAULT_CHANNEL_RULE;
}
