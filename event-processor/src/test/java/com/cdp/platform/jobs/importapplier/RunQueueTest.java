package com.cdp.platform.jobs.importapplier;

import java.time.Instant;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class RunQueueTest {

    private static final String ORDERS = "orders";
    private static final String CUSTOMERS = "customers";

    private static OpenRun run(String id, String type, String state, String confirmedAt) {
        return new OpenRun(id, type, state, "drop", "sk_12", "csv", 10L, "imports/incoming/x.csv", "0".repeat(64),
            Instant.parse("2026-11-14T" + confirmedAt + ":00Z"));
    }

    private static List<String> ids(List<OpenRun> runs) {
        return runs.stream().map(OpenRun::id).toList();
    }

    @Test
    void takesTheRunConfirmedFirst() {
        // IAP-FR-01: the 01:40 run before the 01:45 run, one run per type.
        List<OpenRun> open = List.of(run("b", ORDERS, "queued", "01:45"), run("a", ORDERS, "queued", "01:40"));
        assertEquals(List.of("a"), ids(RunQueue.next(open, type -> true)));
    }

    @Test
    void aHeldRunHoldsAnOrderedTypeButNotOthers() {
        // IAP-FR-02: a quarantined customers snapshot holds the later customers run;
        // orders still goes.
        List<OpenRun> open = List
            .of(run("held", CUSTOMERS, "quarantined", "01:00"),
                run("later", CUSTOMERS, "queued", "01:30"), run("order", ORDERS, "queued", "01:35"));
        assertEquals(List.of("order"), ids(RunQueue.next(open, Set.of(CUSTOMERS)::contains)));
    }

    @Test
    void aFailedRunHoldsLikeAQuarantinedOne() {
        List<OpenRun> open = List
            .of(run("failed", CUSTOMERS, "failed", "01:00"),
                run("later", CUSTOMERS, "queued", "01:30"));
        assertEquals(List.of(), ids(RunQueue.next(open, type -> true)));
    }

    @Test
    void anIncrementalTypeWithUpdatedAtPassesAHeldRun() {
        // IAP-FR-02: orders maps updated_at, so it is not ordered.
        List<OpenRun> open = List
            .of(run("held", ORDERS, "quarantined", "01:00"),
                run("later", ORDERS, "queued", "01:30"));
        assertEquals(List.of("later"), ids(RunQueue.next(open, type -> false)));
    }

    @Test
    void anApprovedHeldRunIsTakenInItsTurn() {
        List<OpenRun> open = List
            .of(run("approved", CUSTOMERS, "approved", "01:00"),
                run("later", CUSTOMERS, "queued", "01:30"));
        assertEquals(List.of("approved"), ids(RunQueue.next(open, type -> true)));
    }

    @Test
    void aHeldRunConfirmedLaterDoesNotHoldAnEarlierOne() {
        List<OpenRun> open = List
            .of(run("retried", CUSTOMERS, "queued", "01:00"),
                run("held", CUSTOMERS, "quarantined", "01:30"));
        assertEquals(List.of("retried"), ids(RunQueue.next(open, type -> true)));
    }
}
