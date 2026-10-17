// подпись APK (v1+v2+v3) ключом из keys/ (создаётся один раз; обновления ставятся поверх, только если ключ тот же)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const [, , input, output, keyDir] = process.argv;
const require = createRequire(import.meta.url);
const { ApkSigner, SigningKey } = await import(process.env.APK_SIGN_TS || '/tmp/claude-0/andk/npm/x-sign/package/dist/index.js');
mkdirSync(keyDir, { recursive: true });
const kp = keyDir + '/kentovka.key.pem', cp = keyDir + '/kentovka.cert.pem';
if (!existsSync(kp)) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', kp, '-out', cp, '-days', '10000', '-subj', '/CN=Kentovka/O=Kentovka']);
}
const signer = new ApkSigner({ signingKey: SigningKey.fromPEM(readFileSync(kp, 'utf8'), readFileSync(cp, 'utf8')) });
const { signedApk } = await signer.sign(new Uint8Array(readFileSync(input)));
writeFileSync(output, signedApk);
console.log('подписано', output, signedApk.length);
