import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

const derive = (password: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) => {
    argon2(
      'argon2id',
      { message: password, nonce: salt, memory: 32768, passes: 3, parallelism: 1, tagLength: 32 },
      (error, value) => (error ? reject(error) : resolve(value)),
    );
  });
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || Buffer.byteLength(password) > 256)
    throw new Error('Password must be 12-256 bytes');
  const salt = randomBytes(16);
  return `$argon2id$v=19$m=32768,t=3,p=1$${salt.toString('base64')}$${(await derive(password, salt)).toString('base64')}`;
}
export async function verifyPassword(password: string, encoded?: string): Promise<boolean> {
  const match =
    encoded &&
    /^\$argon2id\$v=19\$m=32768,t=3,p=1\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(encoded);
  const salt = match ? Buffer.from(match[1]!, 'base64') : Buffer.alloc(16, 1);
  const expected = match ? Buffer.from(match[2]!, 'base64') : Buffer.alloc(32);
  const actual = await derive(password, salt);
  return Boolean(match) && actual.length === expected.length && timingSafeEqual(actual, expected);
}
