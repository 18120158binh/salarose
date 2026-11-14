package com.cdp.platform.shared.db.repositories;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import com.cdp.platform.shared.models.db.UserProfile;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * The lookup of imported fields from {@code customer_attributes} with the
 * profile (DEC-FR-40, DEC-FR-41, DEC-NFR-08).
 */
class CustomerAttributesLookupTest {

    private static final String USER_ID = "0912345678";

    private final ProfileDatabase database = new ProfileDatabase();
    private final UserProfileRepository repository = UserProfileRepository
        .openBounded(database, 1, 100, 5, Duration.ofSeconds(10));

    @AfterEach
    void close() {
        repository.close();
    }

    @Test
    void anImportedFieldResolvesFromTheRowOfItsSourceForTheProfilesUserId() {
        database.addAttributes(USER_ID, "orders", "{\"spend_90d\":12990000,\"tier\":\"gold\",\"gone\":null}");

        UserProfile found = lookUp(Set.of(), Set.of("orders"));

        assertEquals("12990000", found.getField("profile.orders.spend_90d"));
        assertEquals("gold", found.getField("profile.orders.tier"));
        assertNull(found.getField("profile.orders.gone"));
    }

    @Test
    void aBuiltInAndAnImportedFieldAreReadInOneRoundTrip() {
        database.addProfile(USER_ID, "Hanoi");
        database.addAttributes(USER_ID, "orders", "{\"spend_90d\":12990000}");

        UserProfile found = lookUp(Set.of("city"), Set.of("orders"));

        assertEquals("Hanoi", found.city());
        assertEquals("12990000", found.getField("profile.orders.spend_90d"));
        assertEquals(1, database.queries());
    }

    @Test
    void onlyTheNamedSourcesAreRead() {
        database.addAttributes(USER_ID, "orders", "{\"spend_90d\":12990000}");
        database.addAttributes(USER_ID, "customers", "{\"loyalty_tier\":\"gold\"}");

        UserProfile found = lookUp(Set.of(), Set.of("orders"));

        assertEquals(Map.of("orders.spend_90d", "12990000"), found.imported());
        assertEquals(List.of(), database.statements().stream().filter(sql -> sql.contains("'customers'")).toList());
    }

    @Test
    void aLookupWithoutSourcesReadsNoCustomerAttributes() {
        database.addProfile(USER_ID, "Hanoi");

        assertEquals("Hanoi", lookUp(Set.of("city"), Set.of()).city());
        assertEquals(List.of(), database
            .statements()
            .stream()
            .filter(sql -> sql.contains(CustomerAttributesTable.TABLE_NAME))
            .toList());
    }

    @Test
    void importedFieldsAreServedFromTheCache() {
        database.addAttributes(USER_ID, "orders", "{\"spend_90d\":12990000}");
        lookUp(Set.of(), Set.of("orders"));
        database.goDown();

        assertEquals("12990000", lookUp(Set.of(), Set.of("orders")).getField("profile.orders.spend_90d"));
        assertEquals(1, database.queries());
    }

    @Test
    void aRowImportedAfterALookupFoundNoneIsFoundOnTheNextLookup() {
        lookUp(Set.of(), Set.of("orders"));
        database.addAttributes(USER_ID, "orders", "{\"spend_90d\":12990000}");

        assertEquals("12990000", lookUp(Set.of(), Set.of("orders")).getField("profile.orders.spend_90d"));
    }

    @Test
    void aFieldNamesASourceOnlyWhenItIsDottedAfterTheProfilePrefix() {
        assertEquals(Optional.of("orders"), CustomerAttributesTable.sourceOf("profile.orders.spend_90d"));
        assertEquals(Optional.of("orders"), CustomerAttributesTable.sourceOf("profile.orders.items.count"));
        assertEquals(Optional.empty(), CustomerAttributesTable.sourceOf("profile.city"));
        assertEquals(Optional.empty(), CustomerAttributesTable.sourceOf("profile.orders."));
        assertEquals(Optional.empty(), CustomerAttributesTable.sourceOf("profile.Orders.spend_90d"));
        assertEquals(Optional.empty(), CustomerAttributesTable.sourceOf("orders.spend_90d"));
    }

    @Test
    void theCombinedLookupTakesTheUserIdAsItsOneParameter() {
        assertEquals("with \"person\"(\"id\") as (select ?) select \"p\".\"city\", (select "
            + "cast(jsonb_object_agg(\"a\".\"source_id\", \"a\".\"attributes\") as text) from \"customer_attributes\" "
            + "as \"a\" where (\"a\".\"customer_key\" = \"person\".\"id\" and \"a\".\"source_id\" in ('orders'))) as "
            + "\"imported\", (\"p\".\"cdp_uuid\" is not null) as \"profile_found\" from \"person\" left outer join "
            + "\"customer_profiles\" as \"p\" on \"p\".\"cdp_uuid\" = \"person\".\"id\" fetch next 1 rows only",
            CustomerProfilesTable.lookupSql(List.of("city"), List.of("orders")));
    }

    private UserProfile lookUp(Set<String> columns, Set<String> sources) {
        return repository.findProfileAsync(USER_ID, "canon-1", columns, sources).join();
    }
}
