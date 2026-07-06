import * as dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.resolve(__dirname, '../.env.local') })
import { cleanFailedRecords } from './fancore-hygiene'
cleanFailedRecords(process.argv[2] ?? 'minamochi', { max: 5 })
  .then(r => console.log('RESULT', JSON.stringify(r)))
  .catch(e => { console.error('ERROR at:', e.message, '\n', (e.stack ?? '').split('\n').slice(0, 6).join('\n')); process.exit(1) })
