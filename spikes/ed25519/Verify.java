import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;

/**
 * P0-c — verify the JS-produced envelope signature using ONLY Java 11 API classes, so the dexrelay module
 * can compile at --release 11 while running on the JDK >= 15 the fleet and desktop bundles ship.
 * The raw 32-byte Ed25519 key is wrapped in its SubjectPublicKeyInfo DER prefix (RFC 8410).
 *
 *   javac --release 11 Verify.java && java Verify vector.json
 * Prints VALID / INVALID for the vector, then INVALID for a flipped signature byte (expected).
 */
public final class Verify {
    static final byte[] DER_PREFIX = hex("302a300506032b6570032100");

    public static void main(String[] a) throws Exception {
        String json = new String(Files.readAllBytes(Paths.get(a[0])), StandardCharsets.UTF_8);
        byte[] pk = hex(field(json, "signPk").substring(2));
        byte[] msg = hex(field(json, "canonicalHex"));
        byte[] sig = hex(field(json, "sig").substring(2));
        System.out.println("vector   : " + (verify(pk, msg, sig) ? "VALID" : "INVALID"));
        sig[7] ^= 0x01;
        System.out.println("flipped  : " + (verify(pk, msg, sig) ? "VALID" : "INVALID"));
        sig[7] ^= 0x01; msg[3] ^= 0x01;
        System.out.println("tampered : " + (verify(pk, msg, sig) ? "VALID" : "INVALID"));
    }

    /** False on ANY failure: a malformed signature makes the JDK throw (e.g. "Invalid point") rather than return false. */
    static boolean verify(byte[] rawPk, byte[] msg, byte[] sig) {
        try { return verifyOrThrow(rawPk, msg, sig); } catch (Exception e) { return false; }
    }

    static boolean verifyOrThrow(byte[] rawPk, byte[] msg, byte[] sig) throws Exception {
        if (rawPk.length != 32 || sig.length != 64) return false;
        byte[] spki = new byte[DER_PREFIX.length + 32];
        System.arraycopy(DER_PREFIX, 0, spki, 0, DER_PREFIX.length);
        System.arraycopy(rawPk, 0, spki, DER_PREFIX.length, 32);
        PublicKey pub = KeyFactory.getInstance("Ed25519").generatePublic(new X509EncodedKeySpec(spki));
        Signature s = Signature.getInstance("Ed25519");
        s.initVerify(pub); s.update(msg);
        return s.verify(sig);
    }

    /** Minimal field extractor for the flat spike JSON (no JSON library at --release 11, zero deps). */
    static String field(String json, String key) {
        String k = "\"" + key + "\":\"";
        int i = json.indexOf(k); if (i < 0) throw new IllegalArgumentException("missing " + key);
        int s = i + k.length(), e = json.indexOf('"', s);
        return json.substring(s, e);
    }

    static byte[] hex(String h) {
        byte[] out = new byte[h.length() / 2];
        for (int i = 0; i < out.length; i++) out[i] = (byte) Integer.parseInt(h.substring(2 * i, 2 * i + 2), 16);
        return out;
    }
}
