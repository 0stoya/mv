// var/www/middleware/src/config/channelRules.ts
export interface ChannelRule {
  autoInvoice: boolean;
  autoShip: boolean;
}

export const CHANNEL_RULES: Record<string, ChannelRule> = {
  'Admin Bulk Digitisation': {
    autoInvoice: true,
    autoShip: true
  },
    'Order on Behalf': {
    autoInvoice: true,
    autoShip: false  
  }
};

export const DEFAULT_CHANNEL_RULE: ChannelRule = {
  autoInvoice: true,
  autoShip: false
};

export function getChannelRule(channel: string | null | undefined): ChannelRule {
  if (!channel) return DEFAULT_CHANNEL_RULE;
  return CHANNEL_RULES[channel] ?? DEFAULT_CHANNEL_RULE;
}
