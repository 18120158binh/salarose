package com.cdp.platform.jobs.importapplier;

import java.nio.charset.StandardCharsets;
import java.security.InvalidKeyException;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Set;
import java.util.function.Predicate;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * The tombstones of deleted people (IAP-FR-18). A customer key is deleted when
 * the HMAC-SHA-256 of its UTF-8 bytes under the tombstone key, in lowercase
 * hex, is in {@code person_tombstones}, as studio computes it.
 */
final class Tombstones implements Predicate<String> {

    private final Mac mac;
    private final Set<String> hashes;

    Tombstones(String key, Set<String> hashes) {
        try {
            mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        } catch (NoSuchAlgorithmException | InvalidKeyException e) {
            throw new IllegalStateException(e);
        }
        this.hashes = Set.copyOf(hashes);
    }

    static String of(String key, String customerKey) {
        return new Tombstones(key, Set.of()).hash(customerKey);
    }

    String hash(String customerKey) {
        return HexFormat.of().formatHex(mac.doFinal(customerKey.getBytes(StandardCharsets.UTF_8)));
    }

    @Override
    public boolean test(String customerKey) {
        return !hashes.isEmpty() && hashes.contains(hash(customerKey));
    }
}
