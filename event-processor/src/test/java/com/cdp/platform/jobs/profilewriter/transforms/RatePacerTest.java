package com.cdp.platform.jobs.profilewriter.transforms;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class RatePacerTest {

    @Test
    void aBacklogPassesNoFasterThanTheCap() {
        RatePacer<Integer> pacer = new RatePacer<>(10_000);
        pacer.start(1);

        long started = System.nanoTime();
        for (int i = 0; i < 10_000; i++) {
            pacer.map(i);
        }
        double seconds = (System.nanoTime() - started) / 1e9;

        // The first permit is free, so 10,000 records take at least 9,999 / 10,000 s.
        assertTrue(seconds >= 0.99, "10,000 records passed in " + seconds + " s");
    }

    @Test
    void eachSubtaskTakesItsShareOfTheCap() {
        RatePacer<Integer> pacer = new RatePacer<>(4_000);
        pacer.start(4);

        long started = System.nanoTime();
        for (int i = 0; i < 1_001; i++) {
            pacer.map(i);
        }
        double seconds = (System.nanoTime() - started) / 1e9;

        assertTrue(seconds >= 0.99, "1,001 records on one of 4 subtasks passed in " + seconds + " s");
    }

    @Test
    void rejectsACapThatIsNotPositive() {
        assertThrows(IllegalArgumentException.class, () -> new RatePacer<>(0));
        assertThrows(IllegalArgumentException.class, () -> new RatePacer<>(Double.NaN));
    }
}
