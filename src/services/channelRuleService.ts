import { getChannelRuleByChannel } from '../db/repositories/channelRulesRepository';
import { CHANNEL_RULES, DEFAULT_CHANNEL_RULE, ChannelRule } from '../config/channelRules';

export async function resolveChannelRule(
  channel: string | null | undefined
): Promise<ChannelRule> {
  const channelKey = channel || '';

  // 1) Try DB rule
  if (channelKey) {
    const dbRule = await getChannelRuleByChannel(channelKey);
    if (dbRule) {
      return {
        autoInvoice: !!dbRule.auto_invoice,
        autoShip: !!dbRule.auto_ship
      };
    }
  }

  // 2) Fallback to static config
  if (channelKey && CHANNEL_RULES[channelKey]) {
    return CHANNEL_RULES[channelKey];
  }

  // 3) Fallback to default
  return DEFAULT_CHANNEL_RULE;
}
