package com.cdp.platform.jobs.eventparser.transforms;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicLong;

import org.apache.flink.metrics.groups.UnregisteredMetricsGroup;

import com.cdp.platform.jobs.eventparser.transforms.DroppedEvents.Reason;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class DroppedEventsTest {

    private static final String LINE = "Dropping an event without a usable timestamp: ttm, dtm, stm";

    @Test
    void eachReasonLogsAtMostOnceAMinuteWithTheDropsSinceItsLastLine() {
        AtomicLong nanos = new AtomicLong();
        DroppedEvents dropped = new DroppedEvents(new UnregisteredMetricsGroup(), nanos::get);

        String log = capturingLog(() -> {
            dropped.drop(Reason.NO_TIMESTAMP, "ttm, dtm, stm");
            dropped.drop(Reason.NO_TIMESTAMP, "ttm, dtm, stm");
            nanos.set(Duration.ofSeconds(59).toNanos());
            dropped.drop(Reason.NO_TIMESTAMP, "ttm, dtm, stm");
            nanos.set(Duration.ofSeconds(60).toNanos());
            dropped.drop(Reason.NO_TIMESTAMP, "ttm, dtm, stm");
        });

        assertEquals(2, log.lines().filter(line -> line.contains(LINE)).count(), log);
        assertEquals(1, log.lines().filter(line -> line.contains(LINE + " (1 dropped")).count(), log);
        assertEquals(1, log.lines().filter(line -> line.contains(LINE + " (3 dropped")).count(), log);
    }

    // slf4j-simple writes to whatever System.err is at the time of each log call.
    private static String capturingLog(Runnable action) {
        PrintStream original = System.err;
        ByteArrayOutputStream log = new ByteArrayOutputStream();
        System.setErr(new PrintStream(log, true, StandardCharsets.UTF_8));
        try {
            action.run();
        } finally {
            System.setErr(original);
        }
        return log.toString(StandardCharsets.UTF_8);
    }
}
