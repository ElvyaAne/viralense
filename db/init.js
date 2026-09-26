import 'dotenv/config';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

if (!process.env.TIGER_DATABASE_URL || process.env.TIGER_DATABASE_URL.includes('YOUR_PASSWORD')) {
  console.log('No TIGER_DATABASE_URL set — nothing to set up. Viralense will save data to a local file (data/viralense-data.json).');
  process.exit(0);
}

const { default: pg } = await import('pg');
const client = new pg.Client({ connectionString: process.env.TIGER_DATABASE_URL });
await client.connect();
console.log('Connected. Applying schema...');

const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
await client.query(sql);
await client.end();
console.log('Schema applied successfully.');
