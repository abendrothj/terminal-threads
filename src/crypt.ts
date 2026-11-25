import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// History files at rest: AES-256-GCM, a fresh 12-byte IV per write, the thread id as associated
// data so a file can't be swapped in for another thread.
export interface EncryptedFile {
  v: 2;
  iv: string;
  tag: string;
  data: string;
}

export function newKey(): Buffer {
  return randomBytes(32);
}

export function seal(key: Buffer, id: string, plaintext: string): EncryptedFile {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(id));
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { v: 2, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

// Throws if the key is wrong, the id doesn't match, or the file was altered.
export function open(key: Buffer, id: string, file: EncryptedFile): string {
  const iv = Buffer.from(file.iv, 'base64');
  if (iv.length !== 12) throw new Error('terminal-threads: bad IV length');
  // Pinned tag length: older Node accepts truncated GCM tags otherwise.
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  decipher.setAAD(Buffer.from(id));
  decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()]).toString('utf8');
}
