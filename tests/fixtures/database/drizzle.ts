// The type of the Drizzle database that DrizzleModule registers (the stores integration spec).
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;
