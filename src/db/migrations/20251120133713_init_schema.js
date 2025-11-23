/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  // orders
  await knex.schema.createTable('orders', (table) => {
    table.increments('id').primary();
    table.string('file_order_id', 64).notNullable();
    table.string('external_order_id', 64).nullable();
    table.string('order_channel', 64).notNullable();
    table.string('store_code', 64).notNullable();
    table.string('seller_id', 64).nullable();
    table.dateTime('created_date').notNullable();
    table.string('email', 255).nullable();
    table.string('firstname', 255).nullable();
    table.string('lastname', 255).nullable();
    table.string('country_id', 2).nullable();
    table.string('region_id', 32).nullable();
    table.string('region', 255).nullable();
    table.string('postcode', 32).nullable();
    table.text('street').nullable();
    table.string('city', 255).nullable();
    table.string('telephone', 64).nullable();
    table.string('company', 255).nullable();
    table.string('fax', 64).nullable();
    table.string('taxvat', 64).nullable();
    table.string('cnpj', 64).nullable();
    table.string('shipping_method', 64).nullable();
    table.text('delivery_instructions').nullable();
    table.string('coupon_code', 64).nullable();

    table.integer('magento_order_id').nullable();
    table.string('magento_increment_id', 64).nullable();
    table.string('status', 32).notNullable().defaultTo('PENDING'); // PENDING|SYNCED|FAILED
    table.text('last_error').nullable();

    table.dateTime('created_at').notNullable().defaultTo(knex.fn.now());
    table
      .dateTime('updated_at')
      .notNullable()
      .defaultTo(knex.fn.now());

    table.unique(['external_order_id', 'order_channel'], 'uniq_ext_channel');
  });

  // order_items
  await knex.schema.createTable('order_items', (table) => {
    table.increments('id').primary();
    table
      .integer('order_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('orders')
      .onDelete('CASCADE');

    table.string('sku', 128).notNullable();
    table.text('name').nullable();
    table.decimal('qty_ordered', 12, 4).notNullable();
    table.decimal('price', 12, 4).notNullable();
    table.decimal('original_price', 12, 4).nullable();
  });

  // jobs
  await knex.schema.createTable('jobs', (table) => {
    table.increments('id').primary();
    table.string('type', 64).notNullable();
    table.json('payload').notNullable();
    table.string('status', 32).notNullable().defaultTo('PENDING'); // PENDING|RUNNING|DONE|FAILED
    table.integer('attempts').notNullable().defaultTo(0);
    table.text('last_error').nullable();
    table.dateTime('created_at').notNullable().defaultTo(knex.fn.now());
    table
      .dateTime('updated_at')
      .notNullable()
      .defaultTo(knex.fn.now());

    table.index(['status', 'type'], 'idx_jobs_status_type');
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('jobs');
  await knex.schema.dropTableIfExists('order_items');
  await knex.schema.dropTableIfExists('orders');
};
