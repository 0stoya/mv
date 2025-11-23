// FILE: knexfile.cjs
require('dotenv').config();

const {
  DB_CLIENT = 'mysql2',
  DB_HOST = 'localhost',
  DB_PORT = '3306',
  DB_USER = 'root',
  DB_PASSWORD = '',
  DB_NAME = 'middleware'
} = process.env;

/** @type {import('knex').Knex.Config} */
const baseConfig = {
  client: DB_CLIENT,
  connection: {
    host: DB_HOST,
    port: Number(DB_PORT),
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME
  },
  pool: {
    min: 2,
    max: 10
  },
  migrations: {
    tableName: 'knex_migrations',
    directory: './src/db/migrations'
  }
};

module.exports = {
  development: baseConfig,
  production: baseConfig
};
