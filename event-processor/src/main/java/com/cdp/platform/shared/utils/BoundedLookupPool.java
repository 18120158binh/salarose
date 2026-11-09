package com.cdp.platform.shared.utils;

import java.time.Duration;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** A thread pool for lookups that an async operator times out. */
public final class BoundedLookupPool {

    private BoundedLookupPool() {
    }

    /**
     * A pool whose queue holds only as many lookups as its threads finish within
     * the lookup timeout, even when every read takes as long as its limit allows.
     * When the queue is full, the subtask thread runs the lookup itself. That slows
     * the intake of records, where a longer queue would let lookups time out.
     */
    public static ThreadPoolExecutor create(int threads, Duration lookupTimeout, Duration longestRead) {
        int capacity = queueCapacity(threads, lookupTimeout, longestRead);
        BlockingQueue<Runnable> queue = capacity == 0 ? new SynchronousQueue<>() : new ArrayBlockingQueue<>(capacity);
        return new ThreadPoolExecutor(threads, threads, 0, TimeUnit.MILLISECONDS, queue,
            new ThreadPoolExecutor.CallerRunsPolicy());
    }

    /**
     * The lookups that can wait for a thread. A thread finishes one lookup per
     * longest read, so {@code lookupTimeout / longestRead} lookups in time, one of
     * them already running.
     */
    static int queueCapacity(int threads, Duration lookupTimeout, Duration longestRead) {
        long rounds = lookupTimeout.toMillis() / longestRead.toMillis();
        return (int) Math.max(0, threads * (rounds - 1));
    }
}
