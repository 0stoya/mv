/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  const hasNextRunAt = await knex.schema.hasColumn('jobs', 'next_run_at');
  const hasMaxAttempts = await knex.schema.hasColumn('jobs', 'max_attempts');

  await knex.schema.alterTable('jobs', (table) => {
    if (!hasNextRunAt) {
      table.dateTime('next_run_at').nullable().after('attempts');
    }
    if (!hasMaxAttempts) {
      table
        .integer('max_attempts')
        .notNullable()
        .defaultTo(5)
        .after('attempts');
    }
  });

  // Initialize next_run_at for existing rows
  await knex('jobs')
    .whereNull('next_run_at')
    .update({
      next_run_at: knex.fn.now()
    });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  const hasNextRunAt = await knex.schema.hasColumn('jobs', 'next_run_at');
  const hasMaxAttempts = await knex.schema.hasColumn('jobs', 'max_attempts');

  await knex.schema.alterTable('jobs', (table) => {
    if (hasNextRunAt) table.dropColumn('next_run_at');
    if (hasMaxAttempts) table.dropColumn('max_attempts');
  });
};
