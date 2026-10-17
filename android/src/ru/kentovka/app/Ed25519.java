package ru.kentovka.app;

import java.math.BigInteger;
import java.security.MessageDigest;
import java.util.Arrays;

/**
 * Подпись Ed25519 (RFC 8032) без сторонних библиотек — тот же ключ аккаунта, что и в Кентовке на ПК.
 * Медленная, но простая (BigInteger): одна подпись на вход в сервер — доли секунды.
 */
public final class Ed25519 {
    private static final BigInteger P = BigInteger.ONE.shiftLeft(255).subtract(BigInteger.valueOf(19));
    private static final BigInteger L = BigInteger.ONE.shiftLeft(252).add(new BigInteger("27742317777372353535851937790883648493"));
    private static final BigInteger D = BigInteger.valueOf(-121665).multiply(BigInteger.valueOf(121666).modInverse(P)).mod(P);
    private static final BigInteger I = BigInteger.valueOf(2).modPow(P.subtract(BigInteger.ONE).shiftRight(2), P);
    private static final BigInteger TWO = BigInteger.valueOf(2);
    private static final BigInteger[] B;
    static {
        BigInteger by = BigInteger.valueOf(4).multiply(BigInteger.valueOf(5).modInverse(P)).mod(P);
        BigInteger bx = xRecover(by);
        B = new BigInteger[] { bx, by, BigInteger.ONE, bx.multiply(by).mod(P) };
    }

    private static BigInteger xRecover(BigInteger y) {
        BigInteger xx = y.multiply(y).subtract(BigInteger.ONE).multiply(D.multiply(y).multiply(y).add(BigInteger.ONE).modInverse(P));
        BigInteger x = xx.modPow(P.add(BigInteger.valueOf(3)).shiftRight(3), P);
        if (!x.multiply(x).subtract(xx).mod(P).equals(BigInteger.ZERO)) x = x.multiply(I).mod(P);
        if (x.testBit(0)) x = P.subtract(x);
        return x;
    }

    // точки в расширенных координатах (X, Y, Z, T)
    private static BigInteger[] add(BigInteger[] p, BigInteger[] q) {
        BigInteger a = p[1].subtract(p[0]).multiply(q[1].subtract(q[0])).mod(P);
        BigInteger b = p[1].add(p[0]).multiply(q[1].add(q[0])).mod(P);
        BigInteger c = TWO.multiply(p[3]).multiply(q[3]).multiply(D).mod(P);
        BigInteger dd = TWO.multiply(p[2]).multiply(q[2]).mod(P);
        BigInteger e = b.subtract(a), f = dd.subtract(c), g = dd.add(c), h = b.add(a);
        return new BigInteger[] { e.multiply(f).mod(P), g.multiply(h).mod(P), f.multiply(g).mod(P), e.multiply(h).mod(P) };
    }

    private static BigInteger[] mul(BigInteger s, BigInteger[] p) {
        BigInteger[] q = { BigInteger.ZERO, BigInteger.ONE, BigInteger.ONE, BigInteger.ZERO };
        for (int i = s.bitLength() - 1; i >= 0; i--) {
            q = add(q, q);
            if (s.testBit(i)) q = add(q, p);
        }
        return q;
    }

    private static byte[] encode(BigInteger[] p) {
        BigInteger zi = p[2].modInverse(P);
        BigInteger x = p[0].multiply(zi).mod(P), y = p[1].multiply(zi).mod(P);
        byte[] out = le(y, 32);
        if (x.testBit(0)) out[31] |= (byte) 0x80;
        return out;
    }

    private static byte[] le(BigInteger v, int n) {
        byte[] be = v.toByteArray(), out = new byte[n];
        for (int i = 0; i < n && i < be.length; i++) out[i] = be[be.length - 1 - i];
        return out;
    }

    private static BigInteger fromLe(byte[] b, int off, int len) {
        byte[] be = new byte[len + 1];
        for (int i = 0; i < len; i++) be[len - i] = b[off + i];
        return new BigInteger(be);
    }

    private static byte[] sha512(byte[]... parts) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-512");
            for (byte[] x : parts) md.update(x);
            return md.digest();
        } catch (Exception e) { throw new RuntimeException(e); }
    }

    private static BigInteger clamp(byte[] h) {
        byte[] a = Arrays.copyOf(h, 32);
        a[0] &= (byte) 248; a[31] &= (byte) 127; a[31] |= (byte) 64;
        return fromLe(a, 0, 32);
    }

    /** открытый ключ (32 байта) из закрытого (32 байта — «seed») */
    public static byte[] publicKey(byte[] seed) {
        return encode(mul(clamp(sha512(seed)), B));
    }

    /** подпись (64 байта) */
    public static byte[] sign(byte[] seed, byte[] msg) {
        byte[] h = sha512(seed);
        BigInteger a = clamp(h);
        byte[] pub = encode(mul(a, B));
        byte[] prefix = Arrays.copyOfRange(h, 32, 64);
        BigInteger r = fromLe(sha512(prefix, msg), 0, 64).mod(L);
        byte[] rEnc = encode(mul(r, B));
        BigInteger k = fromLe(sha512(rEnc, pub, msg), 0, 64).mod(L);
        BigInteger s = r.add(k.multiply(a)).mod(L);
        byte[] out = new byte[64];
        System.arraycopy(rEnc, 0, out, 0, 32);
        System.arraycopy(le(s, 32), 0, out, 32, 32);
        return out;
    }

    // ключи в форматах Node: открытый — SPKI DER, закрытый — PKCS#8 (DER внутри PEM)
    private static final byte[] SPKI_PREFIX = { 0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00 };
    private static final byte[] PKCS8_PREFIX = { 0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20 };

    public static byte[] spki(byte[] pub) {
        byte[] out = Arrays.copyOf(SPKI_PREFIX, 44);
        System.arraycopy(pub, 0, out, 12, 32);
        return out;
    }

    public static byte[] pkcs8(byte[] seed) {
        byte[] out = Arrays.copyOf(PKCS8_PREFIX, 48);
        System.arraycopy(seed, 0, out, 16, 32);
        return out;
    }

    /** seed из PEM «-----BEGIN PRIVATE KEY-----» (как его пишет Node) */
    public static byte[] seedFromPem(String pem) {
        String b64 = pem.replaceAll("-----[A-Z ]+-----", "").replaceAll("\\s", "");
        byte[] der = java.util.Base64.getDecoder().decode(b64);
        return Arrays.copyOfRange(der, der.length - 32, der.length);
    }

    public static String pem(byte[] seed) {
        String b64 = java.util.Base64.getEncoder().encodeToString(pkcs8(seed));
        return "-----BEGIN PRIVATE KEY-----\n" + b64 + "\n-----END PRIVATE KEY-----\n";
    }
}
