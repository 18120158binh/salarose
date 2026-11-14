package com.cdp.platform.jobs.importapplier;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Predicate;

/**
 * Picks the runs to take, by step 6 of Take a run: each dataset's oldest run
 * at {@code queued} or {@code approved} by {@code confirmed_at}, skipping an
 * ordered type while an earlier run of it is held (IAP-FR-01, IAP-FR-02).
 */
final class RunQueue {

    private static final Comparator<OpenRun> CONFIRMED = Comparator
        .comparing(OpenRun::confirmedAt, Comparator.nullsLast(Comparator.naturalOrder()))
        .thenComparing(OpenRun::id);

    private RunQueue() {
    }

    /**
     * @param open
     *            every run the queue reads, of every type
     * @param ordered
     *            true for a type whose current version is ordered
     * @return at most one run per type, oldest type first
     */
    static List<OpenRun> next(List<OpenRun> open, Predicate<String> ordered) {
        Map<String, List<OpenRun>> byType = new LinkedHashMap<>();
        open
            .stream()
            .sorted(CONFIRMED)
            .forEach(run -> byType
                .computeIfAbsent(run.recordTypeId(),
                    type -> new ArrayList<>())
                .add(run));
        List<OpenRun> taken = new ArrayList<>();
        byType.forEach((type, runs) -> runs.stream().filter(OpenRun::waiting).findFirst().ifPresent(first -> {
            boolean heldBefore = runs.stream().anyMatch(run -> run.held() && CONFIRMED.compare(run, first) < 0);
            if (!heldBefore || !ordered.test(type)) taken.add(first);
        }));
        return taken;
    }
}
