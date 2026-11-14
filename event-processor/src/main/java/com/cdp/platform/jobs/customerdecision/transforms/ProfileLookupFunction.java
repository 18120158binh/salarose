package com.cdp.platform.jobs.customerdecision.transforms;

import java.io.Serializable;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;

import org.apache.flink.api.common.functions.OpenContext;
import org.apache.flink.streaming.api.functions.async.ResultFuture;
import org.apache.flink.streaming.api.functions.async.RichAsyncFunction;
import org.apache.flink.util.function.SerializableSupplier;

import com.cdp.platform.shared.config.DatabaseConfig;
import com.cdp.platform.shared.db.repositories.CustomerAttributesTable;
import com.cdp.platform.shared.db.repositories.CustomerProfilesTable;
import com.cdp.platform.shared.db.repositories.UserProfileRepository;
import com.cdp.platform.shared.models.Event;
import com.cdp.platform.shared.models.db.UserProfile;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Looks up the profile fields that a decision's waiting rules compare, and
 * nothing else. A lookup that fails or times out gives an empty profile, so
 * those rules do not fire.
 */
public final class ProfileLookupFunction extends RichAsyncFunction<Decision, Decision> {

    private static final Logger LOG = LoggerFactory.getLogger(ProfileLookupFunction.class);

    private final SerializableSupplier<ProfileStore> openProfiles;

    private transient ProfileStore profiles;

    public ProfileLookupFunction(DatabaseConfig database, LookupSettings settings) {
        this(() -> repositoryStore(UserProfileRepository
            .openAsync(database, settings.threads(), settings.cacheMaxEntries(), settings.cacheTtlMinutes())));
    }

    /**
     * Opens the store on each subtask with the given supplier. Tests pass one
     * without Postgres.
     */
    ProfileLookupFunction(SerializableSupplier<ProfileStore> openProfiles) {
        this.openProfiles = openProfiles;
    }

    @Override
    public void open(OpenContext context) {
        profiles = openProfiles.get();
    }

    @Override
    public void asyncInvoke(Decision decision, ResultFuture<Decision> resultFuture) {
        Event event = decision.event();
        profiles
            .find(event.userId(), event.canonId(), columns(decision), sources(decision))
            .handle((found, failure) -> {
                if (failure == null) return found;
                LOG
                    .warn("Profile lookup failed for canonId={} with {}, using an empty profile", event.canonId(),
                        cause(failure).getClass().getName());
                return UserProfile.empty();
            })
            .thenAccept(found -> resultFuture.complete(Collections.singletonList(decision.withProfile(found))));
    }

    @Override
    public void timeout(Decision decision, ResultFuture<Decision> resultFuture) {
        LOG.warn("Profile lookup timed out for canonId={}, using an empty profile", decision.event().canonId());
        resultFuture.complete(Collections.singletonList(decision.withProfile(UserProfile.empty())));
    }

    @Override
    public void close() {
        if (profiles != null) profiles.close();
    }

    /** The columns that the waiting rules' fields name. */
    static Set<String> columns(Decision decision) {
        Set<String> columns = new LinkedHashSet<>();
        decision.profileFields().forEach(field -> CustomerProfilesTable.columnOf(field).ifPresent(columns::add));
        return columns;
    }

    /**
     * The imported sources that the waiting rules' fields name, such as
     * {@code orders} for {@code orders.spend_90d} (DEC-FR-41).
     */
    static Set<String> sources(Decision decision) {
        Set<String> sources = new LinkedHashSet<>();
        decision
            .profileFields()
            .forEach(field -> CustomerAttributesTable.sourceOf(field).ifPresent(sources::add));
        return sources;
    }

    private static Throwable cause(Throwable failure) {
        return failure instanceof CompletionException && failure.getCause() != null ? failure.getCause() : failure;
    }

    private static ProfileStore repositoryStore(UserProfileRepository repository) {
        return new ProfileStore() {

            @Override
            public CompletableFuture<UserProfile> find(String userId, String canonId, Set<String> columns,
                Set<String> sources) {
                return repository.findProfileAsync(userId, canonId, columns, sources);
            }

            @Override
            public void close() {
                repository.close();
            }
        };
    }

    /**
     * How many lookups run at once per subtask, and how many found profiles the
     * cache keeps, for how long.
     */
    public record LookupSettings(int threads, int cacheMaxEntries, int cacheTtlMinutes) implements Serializable {
    }

    /**
     * Finds the given columns of a person's profile, and the imported fields of
     * the given sources, by their {@code user_id} and {@code canon_id}, and is
     * closed with the subtask.
     */
    interface ProfileStore extends AutoCloseable {

        CompletableFuture<UserProfile> find(String userId, String canonId, Set<String> columns,
            Set<String> sources);

        @Override
        void close();
    }
}
