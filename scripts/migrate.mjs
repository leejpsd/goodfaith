#!/usr/bin/env node
// Applies the SQL in drizzle/ before each deploy.
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(2);
}
const client = postgres(process.env.DATABASE_URL, { max: 1 });
await migrate(drizzle(client), { migrationsFolder: 'drizzle' });
await client.end();
console.log('Migrations applied.');
