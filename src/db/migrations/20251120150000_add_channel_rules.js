/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('channel_rules', (table) => {
    table.increments('id').primary();
    table.string('channel', 128).notNullable();
    table.boolean('auto_invoice').notNullable().defaultTo(true);
    table.boolean('auto_ship').notNullable().defaultTo(false);
    table.boolean('is_active').notNullable().defaultTo(true);
    table.dateTime('created_at').notNullable().defaultTo(knex.fn.now());
    table
      .dateTime('updated_at')
      .notNullable()
      .defaultTo(knex.fn.now());

    table.unique(['channel'], 'uniq_channel_rules_channel');
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('channel_rules');
};
