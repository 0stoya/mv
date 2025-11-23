/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('imports', (table) => {
    table.increments('id').primary();
    table.string('header_filename', 255).notNullable();
    table.string('items_filename', 255).notNullable();
    table.string('imported_by', 255).notNullable();
    table.integer('total_orders').notNullable().defaultTo(0);
    table.integer('processed_orders').notNullable().defaultTo(0);
    table.integer('failed_orders').notNullable().defaultTo(0);
    table.integer('skipped_orders').notNullable().defaultTo(0);
    table.string('status', 32).notNullable().defaultTo('DONE'); // DONE|FAILED
    table.text('error').nullable();

    table.dateTime('created_at').notNullable().defaultTo(knex.fn.now());
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('imports');
};
