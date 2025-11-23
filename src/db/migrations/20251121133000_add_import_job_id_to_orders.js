// migrations/20251121133000_add_import_job_id_to_orders.js

/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  const hasImportJobId = await knex.schema.hasColumn(
    'orders',
    'import_job_id'
  );

  if (!hasImportJobId) {
    // 1) Add column as unsigned int (to match jobs.id)
    await knex.schema.alterTable('orders', (table) => {
      table
        .integer('import_job_id')
        .unsigned()
        .nullable()
        .index();
    });

    // 2) Add foreign key
    await knex.schema.alterTable('orders', (table) => {
      table
        .foreign('import_job_id')
        .references('id')
        .inTable('jobs')
        .onDelete('SET NULL');
    });
  }
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  const hasImportJobId = await knex.schema.hasColumn(
    'orders',
    'import_job_id'
  );

  if (hasImportJobId) {
    await knex.schema.alterTable('orders', (table) => {
      try {
        table.dropForeign('import_job_id');
      } catch (e) {
        // ignore if FK doesn't exist
      }
      table.dropColumn('import_job_id');
    });
  }
};
