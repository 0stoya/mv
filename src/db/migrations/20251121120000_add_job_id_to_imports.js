// migrations/20251121120000_add_job_id_to_imports.js

/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  const hasJobId = await knex.schema.hasColumn('imports', 'job_id');
  const hasUpdatedAt = await knex.schema.hasColumn('imports', 'updated_at');

  // 1) Ensure columns exist and have the right shape
  await knex.schema.alterTable('imports', (table) => {
    if (!hasJobId) {
      // New project / clean DB: create column
      table.integer('job_id').unsigned().nullable().index();
    } else {
      // Column already exists from a failed migration: ensure UNSIGNED + nullable
      table.integer('job_id').unsigned().nullable().alter();
    }

    if (!hasUpdatedAt) {
      table
        .dateTime('updated_at')
        .notNullable()
        .defaultTo(knex.fn.now());
    }
  });

  // 2) Add foreign key (only if not already there – in your case it failed before)
  await knex.schema.alterTable('imports', (table) => {
    table
      .foreign('job_id')
      .references('id')
      .inTable('jobs')
      .onDelete('SET NULL');
  });

  // 3) Backfill updated_at just in case
  if (!hasUpdatedAt) {
    await knex('imports').update({
      updated_at: knex.fn.now(),
    });
  }
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  const hasJobId = await knex.schema.hasColumn('imports', 'job_id');
  const hasUpdatedAt = await knex.schema.hasColumn('imports', 'updated_at');

  if (hasJobId) {
    await knex.schema.alterTable('imports', (table) => {
      // best-effort: drop FK then column
      try {
        table.dropForeign('job_id');
      } catch (e) {
        // ignore if FK doesn't exist
      }
      table.dropColumn('job_id');
    });
  }

  if (hasUpdatedAt) {
    await knex.schema.alterTable('imports', (table) => {
      table.dropColumn('updated_at');
    });
  }
};
