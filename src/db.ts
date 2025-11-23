import knex, { Knex } from 'knex';

// knexfile.cjs is at project root
// eslint-disable-next-line @typescript-eslint/no-var-requires
const knexfile = require('../knexfile.cjs');

const env = process.env.NODE_ENV || 'development';
const config = knexfile[env] || knexfile;

export const db: Knex = knex(config);

export default db;
