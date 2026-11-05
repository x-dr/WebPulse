import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  publicEncrypt,
  privateDecrypt,
  randomBytes,
} from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

export async function encrypt(input, destination, publicKey) {
  const recipient = createPublicKey(publicKey);
  if (recipient.asymmetricKeyType !== 'rsa' || recipient.asymmetricKeyDetails.modulusLength < 3072)
    throw new Error('RSA 3072 backup recipient required');
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const header =
    JSON.stringify({
      format: 'webpulse-backup-v1',
      nonce: nonce.toString('base64'),
      wrapped_key: publicEncrypt({ key: recipient, oaepHash: 'sha256' }, key).toString('base64'),
    }) + '\n';
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(header));
  const temporary = `${destination}.partial`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.write(header);
    await pipeline(
      input,
      cipher,
      createWriteStream(temporary, {
        fd: file.fd,
        autoClose: false,
        start: Buffer.byteLength(header),
      }),
    );
    await file.write(cipher.getAuthTag(), 0, 16, (await file.stat()).size);
    await file.sync();
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  } finally {
    await file.close();
  }
  await rename(temporary, destination);
}

export async function decrypt(source, destination, privateKey) {
  const file = await open(source, 'r');
  let header;
  let size;
  let tag;
  try {
    size = (await file.stat()).size;
    const start = Buffer.alloc(8192);
    const read = await file.read(start, 0, start.length, 0);
    const end = start.subarray(0, read.bytesRead).indexOf(10);
    if (end < 0 || size <= end + 17) throw new Error('Invalid backup');
    header = start.subarray(0, end + 1);
    tag = Buffer.alloc(16);
    await file.read(tag, 0, 16, size - 16);
  } finally {
    await file.close();
  }
  const metadata = JSON.parse(header.toString());
  if (metadata.format !== 'webpulse-backup-v1') throw new Error('Invalid backup format');
  const key = privateDecrypt(
    { key: privateKey, oaepHash: 'sha256' },
    Buffer.from(metadata.wrapped_key, 'base64'),
  );
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(metadata.nonce, 'base64'));
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  const temporary = `${destination}.partial`;
  try {
    await pipeline(
      createReadStream(source, { start: header.length, end: size - 17 }),
      decipher,
      createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
    );
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
