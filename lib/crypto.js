/**
 * AES-256-GCM at-rest encryption for sensitive scenario fields (credentials).
 *
 * Requires ZONIQ_ENCRYPTION_KEY env var — a base64-encoded 32-byte key.
 * Generate one with: openssl rand -base64 32
 *
 * Encrypted values are prefixed with "enc1:" so plaintext values can be
 * stored alongside encrypted ones safely (no double-encryption, easy migration).
 *
 * If ZONIQ_ENCRYPTION_KEY is not set, encrypt() is a no-op and decrypt() returns
 * the value unchanged — callers work the same in both modes.
 */

const crypto = require("crypto");

const ALGO = "aes-256-gcm";
const PREFIX = "enc1:";

function getKey() {
  const raw = process.env.ZONIQ_ENCRYPTION_KEY;
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      "ZONIQ_ENCRYPTION_KEY must decode to exactly 32 bytes. " +
      "Generate one with: openssl rand -base64 32"
    );
  }
  return key;
}

function encrypt(plaintext) {
  if (plaintext == null || plaintext === "") return plaintext;
  const key = getKey();
  if (!key) return plaintext;
  if (String(plaintext).startsWith(PREFIX)) return plaintext; // already encrypted
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString("base64");
}

function decrypt(value) {
  if (value == null || !String(value).startsWith(PREFIX)) return value;
  const key = getKey();
  if (!key) return value; // can't decrypt without key — return ciphertext unchanged
  const buf = Buffer.from(String(value).slice(PREFIX.length), "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(enc).toString("utf8") + decipher.final("utf8");
}

function encryptCreds(sc) {
  if (!sc || !sc.credentials) return sc;
  return {
    ...sc,
    credentials: {
      ...sc.credentials,
      username: encrypt(sc.credentials.username),
      password: encrypt(sc.credentials.password),
    },
  };
}

function decryptCreds(sc) {
  if (!sc || !sc.credentials) return sc;
  return {
    ...sc,
    credentials: {
      ...sc.credentials,
      username: decrypt(sc.credentials.username),
      password: decrypt(sc.credentials.password),
    },
  };
}

module.exports = { encrypt, decrypt, encryptCreds, decryptCreds };
