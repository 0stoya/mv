import { db } from '../knex';
import { ChannelRuleRow } from '../../types/order';

export async function getChannelRuleByChannel(
  channel: string
): Promise<ChannelRuleRow | undefined> {
  return db<ChannelRuleRow>('channel_rules')
    .where({ channel })
    .andWhere({ is_active: 1 })
    .first();
}

export async function getAllChannelRules(): Promise<ChannelRuleRow[]> {
  return db<ChannelRuleRow>('channel_rules')
    .select('*')
    .orderBy('channel', 'asc');
}

export async function upsertChannelRule(params: {
  channel: string;
  autoInvoice: boolean;
  autoShip: boolean;
  isActive: boolean;
}): Promise<void> {
  const existing = await db<ChannelRuleRow>('channel_rules')
    .where({ channel: params.channel })
    .first();

  if (existing) {
    await db('channel_rules')
      .where({ id: existing.id })
      .update({
        auto_invoice: params.autoInvoice ? 1 : 0,
        auto_ship: params.autoShip ? 1 : 0,
        is_active: params.isActive ? 1 : 0,
        updated_at: db.fn.now()
      });
  } else {
    await db('channel_rules').insert({
      channel: params.channel,
      auto_invoice: params.autoInvoice ? 1 : 0,
      auto_ship: params.autoShip ? 1 : 0,
      is_active: params.isActive ? 1 : 0
    });
  }
}
