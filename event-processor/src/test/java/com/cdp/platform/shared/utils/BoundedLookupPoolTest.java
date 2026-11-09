package com.cdp.platform.shared.utils;

import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ThreadPoolExecutor;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class BoundedLookupPoolTest {

    @Test
    void theQueueHoldsWhatTheThreadsFinishWithinTheTimeoutAtTheLongestRead() {
        assertEquals(10, BoundedLookupPool.queueCapacity(5, Duration.ofSeconds(30), Duration.ofSeconds(10)));
        assertEquals(0, BoundedLookupPool.queueCapacity(5, Duration.ofSeconds(15), Duration.ofSeconds(10)));
        assertEquals(0, BoundedLookupPool.queueCapacity(5, Duration.ofSeconds(5), Duration.ofSeconds(10)));
    }

    @Test
    void aLookupThatFindsThePoolAndQueueFullRunsOnTheCallingThread() throws Exception {
        // One thread and room for one queued lookup.
        ThreadPoolExecutor pool = BoundedLookupPool.create(1, Duration.ofSeconds(2), Duration.ofSeconds(1));
        CountDownLatch release = new CountDownLatch(1);
        try {
            pool.execute(() -> await(release));
            pool.execute(() -> await(release));
            Thread[] ranOn = new Thread[1];

            pool.execute(() -> ranOn[0] = Thread.currentThread());

            assertEquals(Thread.currentThread(), ranOn[0]);
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
    }

    private static void await(CountDownLatch latch) {
        try {
            latch.await();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }
}
