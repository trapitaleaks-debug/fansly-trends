/**
 * One-shot: generate the shared 3D-memoji-style sticker pack (Wave B, user-approved concept).
 * kie.ai seedream/4.5-edit is image-to-image → we hand it a flat #00FF00 canvas and prompt the
 * sticker onto it, then key the green out locally → transparent PNGs in R2 + manifest.json.
 * Stickers only render in production when STICKERS_LIVE=1 AND the template has a sticker slot
 * (user approves the pack first).
 *
 * Run: npx ts-node --project pipeline/tsconfig.json pipeline/generate-stickers.ts
 */
import * as dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.resolve(__dirname, '../.env.local') })

import { execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import { createImageTask, pollTask, uploadFileToKie, sleep } from './kie'
import { uploadToR2, getSignedVideoUrl } from '../lib/r2'

const STYLE = 'A single 3D emoji sticker in glossy Apple-memoji style, centered, large, thick white outline around the sticker, ' +
  'soft studio lighting, high detail, vibrant colors. Plain solid pure green (#00FF00) background with NOTHING else on it. ' +
  'No text, no watermark, no extra objects. The sticker shows: '

const MOODS: Array<{ mood: string; prompt: string; keywords: string[] }> = [
  { mood: 'flirty', prompt: 'a flirty winking face blowing a small kiss with a tiny heart', keywords: ['kiss', 'flirt', 'tease', 'date'] },
  { mood: 'shocked', prompt: 'a shocked wide-eyed face with hands on cheeks', keywords: ['omg', 'what', 'crazy', 'insane', 'shocked'] },
  { mood: 'laughing', prompt: 'a face crying with laughter, tears flying out', keywords: ['lol', 'lmao', 'funny', 'joke'] },
  { mood: 'shy', prompt: 'a shy blushing smiling face with hands together', keywords: ['shy', 'blush', 'cute', 'soft'] },
  { mood: 'devil', prompt: 'a purple smiling devil face with small horns and a mischievous grin', keywords: ['bad', 'naughty', 'devil', 'sin', 'dark'] },
  { mood: 'heart-eyes', prompt: 'a face with big red heart-shaped eyes and an open smile', keywords: ['love', 'heart', 'obsessed', 'crush'] },
  { mood: 'fire', prompt: 'a stylized flame with a cheeky smiling face inside it', keywords: ['hot', 'fire', 'burn', 'spicy'] },
  { mood: 'crying', prompt: 'a face with big dramatic anime tears streaming down', keywords: ['cry', 'sad', 'miss', 'lonely'] },
  { mood: 'side-eye', prompt: 'a skeptical face glancing sideways with raised eyebrow', keywords: ['sus', 'side eye', 'really', 'hmm'] },
  { mood: 'nerd', prompt: 'a grinning nerd face with round glasses and buck teeth', keywords: ['nerd', 'smart', 'study', 'teacher'] },
  { mood: 'sleepy', prompt: 'a sleepy yawning face with a "z z z" floating above', keywords: ['sleep', 'tired', 'bed', 'night', 'morning'] },
  { mood: 'money', prompt: 'a face with dollar signs in the eyes and a money-bill tongue', keywords: ['money', 'pay', 'rich', 'spoil', 'tip'] },
  { mood: 'angel', prompt: 'an innocent smiling angel face with a golden halo', keywords: ['innocent', 'angel', 'good girl', 'pure'] },
  { mood: 'smirk', prompt: 'a confident smirking face with one eyebrow raised', keywords: ['smirk', 'confident', 'dare', 'bet'] },
  { mood: 'melting', prompt: 'a smiling face melting into a puddle', keywords: ['melt', 'dying', 'cant', 'weak'] },
  { mood: 'peach', prompt: 'a glossy peach fruit with a cheeky winking face', keywords: ['peach', 'booty', 'ass', 'cake'] },
  { mood: 'sweat', prompt: 'a nervous face with a big sweat drop and awkward smile', keywords: ['nervous', 'caught', 'oops', 'awkward'] },
  { mood: 'star-eyes', prompt: 'an excited face with golden star-shaped eyes', keywords: ['wow', 'amazing', 'star', 'dream'] },
  { mood: 'kiss-mark', prompt: 'a glossy red lipstick kiss mark with tiny sparkles', keywords: ['lips', 'lipstick', 'mwah'] },
  { mood: 'gym', prompt: 'a flexed bicep arm with a small determined face', keywords: ['gym', 'workout', 'strong', 'leg day', 'fitness'] },
  { mood: 'gamer', prompt: 'a game controller with a happy face on it', keywords: ['game', 'gamer', 'play', 'controller'] },
  { mood: 'coffee', prompt: 'a cozy coffee cup with a sleepy smiling face and steam hearts', keywords: ['coffee', 'cozy', 'morning'] },
  { mood: 'crown', prompt: 'a golden royal crown with tiny sparkles', keywords: ['queen', 'crown', 'royal', 'spoiled'] },
  { mood: 'hundred', prompt: 'a bold red "100" score symbol with an underline, glossy 3D style', keywords: ['100', 'real', 'facts', 'always'] },
]

const CONCURRENCY = 3

async function run() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stickers_'))
  const ff = process.platform === 'darwin' ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg'

  // Flat green base canvas for the edit model
  const basePath = path.join(tmp, 'green.png')
  execSync(`${ff} -y -f lavfi -i color=c=0x00FF00:size=1024x1024 -frames:v 1 "${basePath}"`, { stdio: 'pipe' })
  const baseUrl = await uploadFileToKie(basePath, 'sticker-base-green.png', 'stickers')
  console.log('base canvas uploaded')

  const manifest: Array<{ key: string; mood: string; keywords: string[] }> = []
  const failed: string[] = []
  const queue = [...MOODS]

  async function worker() {
    while (queue.length > 0) {
      const m = queue.shift()!
      try {
        const taskId = await createImageTask(STYLE + m.prompt, [baseUrl], '1:1')
        const resultUrl = await pollTask(taskId, 8 * 60 * 1000)
        const rawPath = path.join(tmp, `${m.mood}_raw.png`)
        execSync(`curl -s -L -o "${rawPath}" "${resultUrl}"`, { stdio: 'pipe', timeout: 120_000 })
        const outPath = path.join(tmp, `${m.mood}.png`)
        // Key the green, trim edge spill, keep the white outline
        execSync(`${ff} -y -i "${rawPath}" -vf "chromakey=0x00FF00:0.22:0.10,despill=type=green,format=rgba" "${outPath}"`, { stdio: 'pipe', timeout: 60_000 })
        const key = `templates/stickers/${m.mood}.png`
        await uploadToR2(key, fs.readFileSync(outPath), 'image/png')
        manifest.push({ key, mood: m.mood, keywords: m.keywords })
        console.log(`✓ ${m.mood}`)
      } catch (e) {
        failed.push(m.mood)
        console.error(`✗ ${m.mood}: ${(e as Error).message.slice(0, 120)}`)
      }
      await sleep(1000)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))

  await uploadToR2('templates/stickers/manifest.json', Buffer.from(JSON.stringify({ stickers: manifest }, null, 2)), 'application/json')
  console.log(`\nDone: ${manifest.length} stickers, ${failed.length} failed${failed.length ? ` (${failed.join(', ')})` : ''}`)
  console.log('\nReview URLs (1h):')
  for (const s of manifest) console.log(`  ${s.mood}: ${await getSignedVideoUrl(s.key, 3600)}`)
}
run().catch(e => { console.error('Fatal:', e); process.exit(1) })
