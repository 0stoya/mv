"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.db = void 0;
const knex_1 = __importDefault(require("knex"));
// knexfile.cjs is at project root
// eslint-disable-next-line @typescript-eslint/no-var-requires
const knexfile = require('../knexfile.cjs');
const env = process.env.NODE_ENV || 'development';
const config = knexfile[env] || knexfile;
exports.db = (0, knex_1.default)(config);
exports.default = exports.db;
