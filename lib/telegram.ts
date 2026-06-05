const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!
const CHAT_ID = process.env.TELEGRAM_MANAGER_CHAT_ID!
const API = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`

export async function sendTelegram(text: string): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) return
  try {
    await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' }),
    })
  } catch {
    // non-fatal
  }
}

export const scraperSuccess = (added: number, updated: number, skipped: number) =>
  `✅ <b>FanslyTrends scrape done</b>\n\n📥 New: ${added}\n🔄 Updated: ${updated}\n⏭ Skipped: ${skipped}`

export const scraperError = (err: string) =>
  `🚨 <b>FanslyTrends scraper failed</b>\n\n<code>${err.slice(0, 300)}</code>`

export const velocityDone = (updated: number) =>
  `📊 <b>FanslyTrends velocity check done</b>\n\n🔄 Posts updated: ${updated}`
