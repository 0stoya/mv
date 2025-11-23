/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  // Add imported_by if it doesn't exist
  const hasImportedBy = await knex.schema.hasColumn('orders', 'imported_by');

  if (!hasImportedBy) {
    await knex.schema.alterTable('orders', (table) => {
      table.string('imported_by', 255).nullable();
    });
  }

  // Add uniqueness on (file_order_id, order_channel)
  // so the same file_order_id for the same channel can't be duplicated
  await knex.schema.alterTable('orders', (table) => {
    table.unique(['file_order_id', 'order_channel'], 'uniq_file_channel');
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.alterTable('orders', (table) => {
    table.dropUnique(['file_order_id', 'order_channel'], 'uniq_file_channel');
    table.dropColumn('imported_by');
  });
};
