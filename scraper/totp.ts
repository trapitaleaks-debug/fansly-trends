import * as crypto from 'crypto'

function base32Decode(secret: string): Buffer {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const c of secret.toUpperCase().replace(/=+$/, '').replace(/\s/g, '')) {
    const v = chars.indexOf(c)
    if (v >= 0) bits += v.toString(2).padStart(5, '0')
  }
  const bytes = bits.match(/.{1,8}/g)!.filter(b => b.length === 8).map(b => parseInt(b, 2))
  return Buffer.from(bytes)
}

export function generateTOTP(secret: string): string {
  const key = base32Decode(secret)
  const counter = Math.floor(Date.now() / 1000 / 30)
  const buf = Buffer.alloc(8)
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0)
  buf.writeUInt32BE(counter >>> 0, 4)
  const hmac = crypto.createHmac('sha1', key)
  hmac.update(buf)
  const hash = hmac.digest()
  const offset = hash[hash.length - 1] & 0x0f
  const code = ((hash[offset] & 0x7f) << 24) | ((hash[offset + 1] & 0xff) << 16) |
               ((hash[offset + 2] & 0xff) << 8) | (hash[offset + 3] & 0xff)
  return (code % 1_000_000).toString().padStart(6, '0')
}

export function secondsUntilExpiry(): number {
  return 30 - (Math.floor(Date.now() / 1000) % 30)
}
