package com.cdp.platform.jobs.importapplier;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * The keys a file has shown so far, for the duplicate checks and the distinct
 * customer keys. A file may hold millions of keys, and IAP-NFR-01 gives the
 * applier 2 GiB, so each key is kept as the first 128 bits of its SHA-256 in an
 * open-addressing table: 16 bytes a key, and a false match about once in
 * 10^25 files of 10 million keys.
 */
final class SeenKeys {

    private final MessageDigest digest;
    private long[] table = new long[2 * 1024];
    private int size;

    SeenKeys() {
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Adds the key, byte for byte. True when the file has not shown it before. */
    boolean add(String key) {
        ByteBuffer hash = ByteBuffer.wrap(digest.digest(key.getBytes(StandardCharsets.UTF_8)));
        long high = hash.getLong();
        long low = hash.getLong();
        // 0,0 marks an empty slot, so that one hash is moved off it.
        if (high == 0 && low == 0) low = 1;
        // Grow past a load of 3/4: table.length holds two longs a slot.
        if ((size + 1) * 8L > table.length * 3L) grow();
        return insert(table, high, low);
    }

    int size() {
        return size;
    }

    private boolean insert(long[] slots, long high, long low) {
        int mask = slots.length / 2 - 1;
        int slot = (int) (low ^ low >>> 32) & mask;
        while (true) {
            long storedHigh = slots[2 * slot];
            long storedLow = slots[2 * slot + 1];
            if (storedHigh == 0 && storedLow == 0) {
                slots[2 * slot] = high;
                slots[2 * slot + 1] = low;
                if (slots == table) size++;
                return true;
            }
            if (storedHigh == high && storedLow == low) return false;
            slot = slot + 1 & mask;
        }
    }

    private void grow() {
        long[] old = table;
        long[] bigger = new long[old.length * 2];
        for (int i = 0; i < old.length; i += 2) {
            if (old[i] != 0 || old[i + 1] != 0) insert(bigger, old[i], old[i + 1]);
        }
        table = bigger;
    }
}
