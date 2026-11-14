package com.cdp.platform.jobs.profilewriter.transforms;

import org.apache.flink.api.common.functions.OpenContext;
import org.apache.flink.api.common.functions.RichMapFunction;
import org.apache.flink.shaded.guava33.com.google.common.util.concurrent.RateLimiter;

/**
 * Passes records on at no more than {@code maxPerSecond} across all subtasks.
 * Each subtask takes an equal share and blocks until it may pass the next
 * record, so a backlog backs up into the source instead of the database.
 */
public final class RatePacer<T> extends RichMapFunction<T, T> {

    private final double maxPerSecond;
    private transient RateLimiter limiter;

    public RatePacer(double maxPerSecond) {
        if (!(maxPerSecond > 0)) throw new IllegalArgumentException("maxPerSecond must be positive: " + maxPerSecond);
        this.maxPerSecond = maxPerSecond;
    }

    @Override
    public void open(OpenContext context) {
        start(getRuntimeContext().getTaskInfo().getNumberOfParallelSubtasks());
    }

    /**
     * Starts pacing one of {@code parallelism} subtasks at its share of the cap.
     */
    void start(int parallelism) {
        limiter = RateLimiter.create(maxPerSecond / parallelism);
    }

    @Override
    public T map(T value) {
        limiter.acquire();
        return value;
    }
}
