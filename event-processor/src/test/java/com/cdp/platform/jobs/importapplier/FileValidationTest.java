package com.cdp.platform.jobs.importapplier;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;
import java.util.concurrent.TimeUnit;

import com.cdp.platform.shared.batch.LockGuard;
import com.cdp.platform.shared.batch.Tombstones;
import com.cdp.platform.shared.models.imports.DatasetVersion;
import com.cdp.platform.shared.utils.PlaceholderIds;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;

class FileValidationTest {

    static final String HEADER = "order_id,customer_id,event_time,amount\r\n";

    static FileValidation validation() throws Exception {
        DatasetVersion version = LargeFileCheck.orders();
        RowValidator validator = new RowValidator(version, new Contacts("VN"), PlaceholderIds.DEFAULT,
            new Tombstones("k".repeat(32), Set.of()), Instant.parse("2026-11-14T01:50:00Z"),
            Limits.DEFAULT.historyLimit(), Limits.DEFAULT.futureLimit());
        return new FileValidation(version, validator, new GoldenFixturesTest.RecordingLookups(),
            (line, reason, raw) -> {
            }, valid -> {
            }, LockGuard.none());
    }

    static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static List<String> failureOf(String format, long size, String sha, byte[] file) {
        return assertThrows(FileFailure.class, () -> validation()
            .validate(new FileValidation.Delivered(format, size, sha), new ByteArrayInputStream(file))).reasons();
    }

    @Test
    void aFileWhoseChecksumDiffersFailsAsChecksumMismatch() {
        byte[] file = (HEADER + "o-1,c-1,2026-11-07,5\r\n").getBytes(StandardCharsets.UTF_8);
        assertEquals(List.of(FileFailure.CHECKSUM_MISMATCH), failureOf("csv", file.length, "0".repeat(64), file));
    }

    @Test
    void aFileWhoseSizeDiffersFailsAsChecksumMismatch() throws Exception {
        byte[] file = (HEADER + "o-1,c-1,2026-11-07,5\r\n").getBytes(StandardCharsets.UTF_8);
        assertEquals(List.of(FileFailure.CHECKSUM_MISMATCH), failureOf("csv", file.length + 1, sha256(file), file));
    }

    @Test
    void aChecksumMismatchWinsOverAFormatFailure() {
        byte[] file = "order_id,customer_id\r\n\"broken".getBytes(StandardCharsets.UTF_8);
        assertEquals(List.of(FileFailure.CHECKSUM_MISMATCH), failureOf("csv", file.length, "1".repeat(64), file));
    }

    @Test
    void anXlsxRunIsAFormatFailure() throws Exception {
        byte[] file = "PK".getBytes(StandardCharsets.UTF_8);
        assertEquals(List.of(FileFailure.FORMAT_INVALID), failureOf("xlsx", file.length, sha256(file), file));
    }

    @Test
    void aRecordPastTheLimitIsAFormatFailureWhileStreaming() throws Exception {
        // An unterminated quote over 16 MiB: the reader stops at 1 MiB instead of
        // buffering the rest.
        byte[] head = (HEADER + "o-1,\"").getBytes(StandardCharsets.UTF_8);
        byte[] file = new byte[head.length + (16 << 20)];
        System.arraycopy(head, 0, file, 0, head.length);
        Arrays.fill(file, head.length, file.length, (byte) 'a');
        assertEquals(List.of(FileFailure.FORMAT_INVALID), failureOf("csv", file.length, sha256(file), file));
        byte[] ndjson = new byte[16 << 20];
        Arrays.fill(ndjson, (byte) 'a');
        assertEquals(List.of(FileFailure.FORMAT_INVALID),
            failureOf("ndjson", ndjson.length, sha256(ndjson), ndjson));
    }

    @Test
    void theLoggedReasonsOfAFileWithoutAHeaderRowHoldNoCellValue() throws Exception {
        // IAP-NFR-04: with no header row, the first data row's cells become the
        // column_unknown headers.
        byte[] file = "o-1,secret@example.com,2026-11-07\r\n".getBytes(StandardCharsets.UTF_8);
        FileFailure failure = assertThrows(FileFailure.class, () -> validation()
            .validate(new FileValidation.Delivered("csv", file.length, sha256(file)), new ByteArrayInputStream(file)));
        assertTrue(failure.getMessage().contains("secret@example.com"));
        assertEquals("column_unknown, role_missing", failure.reasonCodes());
    }

    @Test
    void aFileStreamsInAHeapSmallerThanTheFile() throws Exception {
        // A 32 MiB file in 96 MiB of heap: holding the file whole as text would take 64
        // MiB of chars alone.
        assertStreams(32L << 20, "-Xmx96m");
    }

    @Test
    @EnabledIfSystemProperty(named = "import.largeFile", matches = "true")
    void aFileOf512MibStreamsWithinTheMemoryOfTheApplierPod() throws Exception {
        // IAP-NFR-01: 1.5 GiB of heap, under the pod's 2 GiB limit. About 2.5 minutes,
        // so CI leaves it out:
        // run it with -Dimport.largeFile=true after a change to the applier's read
        // path.
        assertStreams(512L << 20, "-Xmx1536m");
    }

    private static void assertStreams(long size, String heap) throws Exception {
        String java = System.getProperty("java.home") + File.separator + "bin" + File.separator + "java";
        Process child = new ProcessBuilder(java, heap, "-cp", System.getProperty("java.class.path"),
            LargeFileCheck.class.getName(), String.valueOf(size)).redirectErrorStream(true).start();
        String output = new String(child.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertTrue(child.waitFor(10, TimeUnit.MINUTES), "the check timed out");
        assertEquals(0, child.exitValue(), output);
        assertTrue(output.contains("rows_read="), output);
        System.out.println(output.strip());
    }
}
