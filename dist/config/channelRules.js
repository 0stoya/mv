"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_CHANNEL_RULE = exports.CHANNEL_RULES = void 0;
exports.getChannelRule = getChannelRule;
exports.CHANNEL_RULES = {
    'Admin Bulk Digitisation': {
        autoInvoice: true,
        autoShip: true
    },
    'Order on Behalf': {
        autoInvoice: true,
        autoShip: false
    }
};
exports.DEFAULT_CHANNEL_RULE = {
    autoInvoice: true,
    autoShip: false
};
function getChannelRule(channel) {
    if (!channel)
        return exports.DEFAULT_CHANNEL_RULE;
    return exports.CHANNEL_RULES[channel] ?? exports.DEFAULT_CHANNEL_RULE;
}
