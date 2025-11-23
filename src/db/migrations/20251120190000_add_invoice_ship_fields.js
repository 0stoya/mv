/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('orders', (table) => {
    table.integer('magento_invoice_id').nullable();
    table.dateTime('invoiced_at').nullable();

    table.integer('magento_shipment_id').nullable();
    table.dateTime('shipped_at').nullable();
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.alterTable('orders', (table) => {
    table.dropColumn('magento_invoice_id');
    table.dropColumn('invoiced_at');
    table.dropColumn('magento_shipment_id');
    table.dropColumn('shipped_at');
  });
};
