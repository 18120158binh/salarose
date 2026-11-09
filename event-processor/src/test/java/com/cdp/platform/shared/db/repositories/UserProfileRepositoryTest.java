package com.cdp.platform.shared.db.repositories;

import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;

import com.cdp.platform.shared.config.DatabaseConfig;
import com.cdp.platform.shared.models.db.UserProfile;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

class UserProfileRepositoryTest {

    private final ProfileDatabase database = new ProfileDatabase();
    private final UserProfileRepository repository = UserProfileRepository
        .openBounded(database, 1, 100, 5, Duration.ofSeconds(10));

    @AfterEach
    void close() {
        repository.close();
    }

    @Test
    void lookupsGoToTheJobsReadReplica() {
        try (UserProfileRepository replica = UserProfileRepository
            .openBounded(new DatabaseConfig("primary.invalid", "5432", "cdp", "secret", "cdp",
                "jdbc:postgresql://primary.invalid:5432/cdp", "jdbc:postgresql://replica.invalid:5432/cdp", 10), 1, 100,
                5,
                Duration.ofSeconds(10))) {
            assertEquals("jdbc:postgresql://replica.invalid:5432/cdp", replica.dataSource.getJdbcUrl());
        }
    }

    @Test
    void aProfileIsFoundOnTheFirstLookupAfterAnOutage() {
        database.addProfile("0912345678", "Hanoi");
        database.goDown();
        lookUp("0912345678");
        database.comeBack();

        assertEquals("Hanoi", lookUp("0912345678").city());
    }

    @Test
    void aProfileCreatedAfterALookupFoundNoneIsFoundOnTheNextLookup() {
        lookUp("0912345678");
        database.addProfile("0912345678", "Hanoi");

        assertEquals("Hanoi", lookUp("0912345678").city());
    }

    @Test
    void aFoundProfileIsServedFromTheCache() {
        database.addProfile("0912345678", "Hanoi");
        lookUp("0912345678");
        database.goDown();

        assertEquals("Hanoi", lookUp("0912345678").city());
        assertEquals(1, database.queries());
    }

    @Test
    void aPersonWithAUserIdIsLookedUpByIt() {
        database.addProfile("0912345678", "Hanoi");
        database.addIdentity("canon-1", "0987654321");

        assertEquals("Hanoi", repository.findProfileAsync("0912345678", "canon-1").join().city());
    }

    @Test
    void aPersonWithoutAUserIdIsLookedUpByTheUserIdOfTheirCanonId() {
        database.addProfile("0912345678", "Hanoi");
        database.addIdentity("canon-1", "0912345678");

        assertEquals("Hanoi", repository.findProfileAsync(null, "canon-1").join().city());
        assertEquals("Hanoi", repository.findProfileAsync(" ", "canon-1").join().city());
    }

    @Test
    void aPersonWithNeitherAUserIdNorOneForTheirCanonIdHasNoProfile() {
        database.addProfile("canon-1", "Hanoi");

        assertEquals(UserProfile.empty(), repository.findProfileAsync(null, "canon-1").join());
        assertEquals(UserProfile.empty(), repository.findProfileAsync(null, null).join());
    }

    @Test
    void aCanonIdWhoseUserIdWasNotFoundIsFoundOnTheNextLookup() {
        database.addProfile("0912345678", "Hanoi");
        repository.findProfileAsync(null, "canon-1").join();
        database.addIdentity("canon-1", "0912345678");

        assertEquals("Hanoi", repository.findProfileAsync(null, "canon-1").join().city());
    }

    /**
     * The only lookup thread is stuck, and the lookup timeout leaves no time for a
     * lookup to wait behind it. The next lookup runs on the calling thread instead
     * of waiting in a queue until it times out.
     */
    @Test
    void aLookupThatFindsEveryThreadBusyDoesNotWaitBehindIt() throws Exception {
        database.addProfile("0912345678", "Hanoi");
        CountDownLatch release = new CountDownLatch(1);
        database.hangNextLookupUntil(release);
        try {
            repository.findProfileAsync("0987654321", null);
            awaitQueries(1);

            CompletableFuture<UserProfile> next = repository.findProfileAsync("0912345678", null);

            assertTrue(next.isDone());
            assertEquals("Hanoi", next.join().city());
        } finally {
            release.countDown();
        }
    }

    /**
     * A lookup that the outbox cancelled after its timeout, while it still waited
     * for the stuck thread, gives the thread back without a query.
     */
    @Test
    void aLookupCancelledWhileItWaitsForAThreadSkipsItsQuery() throws Exception {
        // One thread, and a timeout long enough for one lookup to wait behind it.
        UserProfileRepository queueing = UserProfileRepository
            .openBounded(database, 1, 100, 5,
                Duration.ofMillis(4 * database.getConnectionTimeout()));
        CountDownLatch release = new CountDownLatch(1);
        database.hangNextLookupUntil(release);
        try {
            CompletableFuture<UserProfile> stuck = queueing.findProfileAsync("0987654321", null);
            awaitQueries(1);
            CompletableFuture<UserProfile> waiting = queueing.findProfileAsync("0912345678", null);

            waiting.cancel(false);
            release.countDown();
            stuck.join();

            queueing.findProfileAsync("0900000000", null).join();

            // The stuck lookup and the last one.
            assertEquals(2, database.queries());
        } finally {
            release.countDown();
            queueing.close();
        }
    }

    private void awaitQueries(int count) throws InterruptedException {
        long deadline = System.nanoTime() + 5_000_000_000L;
        while (database.queries() < count && System.nanoTime() < deadline) {
            Thread.sleep(10);
        }
        assertEquals(count, database.queries());
    }

    /** Looks a profile up as the callers do, with an empty profile on failure. */
    private UserProfile lookUp(String cdpUuid) {
        return repository.findProfileAsync(cdpUuid, null).exceptionally(failure -> UserProfile.empty()).join();
    }
}
