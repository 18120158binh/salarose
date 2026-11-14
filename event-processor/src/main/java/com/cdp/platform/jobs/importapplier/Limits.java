package com.cdp.platform.jobs.importapplier;

import java.time.Period;

/**
 * The applier's configurable limits (IAP-NFR-03).
 *
 * @param rejectThreshold
 *            the share of rejected rows above which a run is quarantined
 * @param shrinkRatio
 *            the share of the type's last source-key snapshot below which a
 *            snapshot is quarantined
 * @param recordCap
 *            the most rows {@code import_records} may hold
 * @param historyLimit
 *            how long before the run's start an event time may be
 * @param futureLimit
 *            how long after the run's start an event time may be
 */
record Limits(double rejectThreshold, double shrinkRatio, long recordCap, Period historyLimit, Period futureLimit) {

    static final Limits DEFAULT = new Limits(0.05, 0.80, 5_000_000L, Period.ofYears(3), Period.ofDays(1));
}
