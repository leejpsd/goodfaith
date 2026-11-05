import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

let instance: PostgresJsDatabase<typeof schema> | undefined;

// Created on first use, so a build needs no database.
export function db() {
  if (!instance) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    instance = drizzle(postgres(url, { max: 5 }), { schema });
  }
  return instance;
}
