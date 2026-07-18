/**
 * offboard-r2-cleanup.mjs — delete ALL R2 objects belonging to an offboarded model.
 *
 * Lives in fansly-trends because the R2 credentials (.env.local) and @aws-sdk/client-s3
 * live here. Invoked by fansly-onboarding-automation/scripts/offboard-model.mjs.
 *
 * Usage:
 *   node scripts/offboard-r2-cleanup.mjs --handle <lowercase-username> [--keys-file <json>] [--confirm]
 *
 * Dry-run by default: enumerates and prints what would be deleted. --confirm deletes.
 * --keys-file: JSON array of extra object keys (collected from DB rows before their deletion).
 * Prefixes always swept: models/<handle>/ and reposts/<handle>/.
 */
import { config } from 'dotenv';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, '..', '.env.local') });

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const CONFIRM = argv.includes('--confirm');
const handle = (flag('--handle') || '').toLowerCase();
if (!handle) { console.error('Usage: node scripts/offboard-r2-cleanup.mjs --handle <username> [--keys-file <json>] [--confirm]'); process.exit(1); }

const BUCKET = process.env.R2_BUCKET_NAME || 'fansly-trends';
const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});

async function listPrefix(prefix) {
  const keys = [];
  let token;
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }));
    for (const o of res.Contents || []) keys.push({ key: o.Key, size: o.Size || 0 });
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function main() {
  const prefixes = [`models/${handle}/`, `reposts/${handle}/`];
  const keysFile = flag('--keys-file');
  const extra = keysFile ? JSON.parse(readFileSync(keysFile, 'utf8')) : [];

  const found = new Map(); // key → size
  for (const p of prefixes) {
    const keys = await listPrefix(p);
    console.log(`  prefix ${p} → ${keys.length} object(s)`);
    for (const { key, size } of keys) found.set(key, size);
  }
  // extra keys may include prefixes (entries ending with /) — expand those too
  for (const k of extra) {
    if (!k) continue;
    if (String(k).endsWith('/')) for (const { key, size } of await listPrefix(k)) found.set(key, size);
    else if (!found.has(k)) found.set(k, -1); // size unknown; DeleteObjects doesn't care if missing
  }

  const all = [...found.keys()];
  const totalMB = ([...found.values()].filter(s => s > 0).reduce((a, b) => a + b, 0) / 1024 / 1024).toFixed(1);
  console.log(`\n  bucket ${BUCKET}: ${all.length} object(s), ~${totalMB} MB${CONFIRM ? '' : '  [DRY RUN — pass --confirm to delete]'}`);
  if (!CONFIRM || !all.length) { console.log(JSON.stringify({ dryRun: !CONFIRM, count: all.length })); return; }

  let deleted = 0;
  for (let i = 0; i < all.length; i += 1000) {
    const batch = all.slice(i, i + 1000).map(Key => ({ Key }));
    const res = await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: batch, Quiet: true } }));
    deleted += batch.length - (res.Errors?.length || 0);
    for (const e of res.Errors || []) console.error(`  ⚠️  ${e.Key}: ${e.Message}`);
  }
  console.log(`  ✅ deleted ${deleted}/${all.length}`);
  console.log(JSON.stringify({ dryRun: false, count: all.length, deleted }));
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
