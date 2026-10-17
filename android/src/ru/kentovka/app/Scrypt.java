package ru.kentovka.app;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** scrypt (RFC 7914) — чтобы открывать сохранения аккаунта с паролем, сделанные на ПК. */
public final class Scrypt {
    public static byte[] derive(byte[] pass, byte[] salt, int N, int r, int p, int dkLen) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(pass, "HmacSHA256"));
        byte[] B = pbkdf2(mac, salt, p * 128 * r);
        int[] XY = new int[64 * r];
        int[] V = new int[32 * r * N];
        for (int i = 0; i < p; i++) smix(B, i * 128 * r, r, N, V, XY);
        return pbkdf2(mac, B, dkLen);
    }

    private static byte[] pbkdf2(Mac mac, byte[] salt, int dkLen) throws Exception {
        byte[] out = new byte[dkLen];
        int blocks = (dkLen + 31) / 32;
        for (int i = 1; i <= blocks; i++) {
            mac.update(salt);
            mac.update(new byte[] { (byte) (i >>> 24), (byte) (i >>> 16), (byte) (i >>> 8), (byte) i });
            byte[] u = mac.doFinal();
            System.arraycopy(u, 0, out, (i - 1) * 32, Math.min(32, dkLen - (i - 1) * 32));
        }
        return out; // c = 1: одна итерация, как в scrypt
    }

    private static void smix(byte[] B, int off, int r, int N, int[] V, int[] XY) {
        int words = 32 * r;
        int[] X = new int[words];
        for (int k = 0; k < words; k++) {
            int j = off + k * 4;
            X[k] = (B[j] & 0xff) | (B[j + 1] & 0xff) << 8 | (B[j + 2] & 0xff) << 16 | (B[j + 3] & 0xff) << 24;
        }
        for (int i = 0; i < N; i++) { System.arraycopy(X, 0, V, i * words, words); blockMix(X, r, XY); }
        for (int i = 0; i < N; i++) {
            int j = X[(2 * r - 1) * 16] & (N - 1);
            for (int k = 0; k < words; k++) X[k] ^= V[j * words + k];
            blockMix(X, r, XY);
        }
        for (int k = 0; k < words; k++) {
            int j = off + k * 4, v = X[k];
            B[j] = (byte) v; B[j + 1] = (byte) (v >>> 8); B[j + 2] = (byte) (v >>> 16); B[j + 3] = (byte) (v >>> 24);
        }
    }

    private static void blockMix(int[] B, int r, int[] Y) {
        int[] X = new int[16];
        System.arraycopy(B, (2 * r - 1) * 16, X, 0, 16);
        for (int i = 0; i < 2 * r; i++) {
            for (int k = 0; k < 16; k++) X[k] ^= B[i * 16 + k];
            salsa8(X);
            System.arraycopy(X, 0, Y, i * 16, 16);
        }
        for (int i = 0; i < r; i++) System.arraycopy(Y, (2 * i) * 16, B, i * 16, 16);
        for (int i = 0; i < r; i++) System.arraycopy(Y, (2 * i + 1) * 16, B, (i + r) * 16, 16);
    }

    private static int R(int a, int b) { return (a << b) | (a >>> (32 - b)); }

    private static void salsa8(int[] B) {
        int[] x = B.clone();
        for (int i = 0; i < 8; i += 2) {
            x[4] ^= R(x[0] + x[12], 7); x[8] ^= R(x[4] + x[0], 9); x[12] ^= R(x[8] + x[4], 13); x[0] ^= R(x[12] + x[8], 18);
            x[9] ^= R(x[5] + x[1], 7); x[13] ^= R(x[9] + x[5], 9); x[1] ^= R(x[13] + x[9], 13); x[5] ^= R(x[1] + x[13], 18);
            x[14] ^= R(x[10] + x[6], 7); x[2] ^= R(x[14] + x[10], 9); x[6] ^= R(x[2] + x[14], 13); x[10] ^= R(x[6] + x[2], 18);
            x[3] ^= R(x[15] + x[11], 7); x[7] ^= R(x[3] + x[15], 9); x[11] ^= R(x[7] + x[3], 13); x[15] ^= R(x[11] + x[7], 18);
            x[1] ^= R(x[0] + x[3], 7); x[2] ^= R(x[1] + x[0], 9); x[3] ^= R(x[2] + x[1], 13); x[0] ^= R(x[3] + x[2], 18);
            x[6] ^= R(x[5] + x[4], 7); x[7] ^= R(x[6] + x[5], 9); x[4] ^= R(x[7] + x[6], 13); x[5] ^= R(x[4] + x[7], 18);
            x[11] ^= R(x[10] + x[9], 7); x[8] ^= R(x[11] + x[10], 9); x[9] ^= R(x[8] + x[11], 13); x[10] ^= R(x[9] + x[8], 18);
            x[12] ^= R(x[15] + x[14], 7); x[13] ^= R(x[12] + x[15], 9); x[14] ^= R(x[13] + x[12], 13); x[15] ^= R(x[14] + x[13], 18);
        }
        for (int i = 0; i < 16; i++) B[i] += x[i];
    }
}
