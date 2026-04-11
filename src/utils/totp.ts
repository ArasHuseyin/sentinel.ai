/**
 * TOTP (Time-based One-Time Password) generator — RFC 6238.
 * Zero dependencies. Uses Node.js built-in crypto.
 *
 * Usage:
 *   generateTOTP('JBSWY3DPEHPK3PXP')  // → '492039'
 */
import { createHmac } from 'crypto';

/** Decode a base32-encoded string to a Buffer. */
function base32Decode(encoded: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = encoded.replace(/[\s=-]/g, '').toUpperCase();
  let bits = '';
  for (const c of cleaned) {
    const val = alphabet.indexOf(c);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/**
 * Generate a TOTP code from a base32-encoded secret.
 * @param secret  Base32-encoded secret (from Google Authenticator / QR code)
 * @param digits  Number of digits (default: 6)
 * @param period  Time step in seconds (default: 30)
 * @returns       Zero-padded TOTP code string
 */
export function generateTOTP(secret: string, digits = 6, period = 30): string {
  const key = base32Decode(secret);
  const counter = Math.floor(Date.now() / 1000 / period);

  // Counter as 8-byte big-endian buffer
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuf.writeUInt32BE(counter & 0xffffffff, 4);

  // HMAC-SHA1
  const hmac = createHmac('sha1', key).update(counterBuf).digest();

  // Dynamic truncation (RFC 4226 §5.4)
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);

  return (code % 10 ** digits).toString().padStart(digits, '0');
}
