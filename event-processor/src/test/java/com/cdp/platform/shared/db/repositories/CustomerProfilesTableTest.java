package com.cdp.platform.shared.db.repositories;

import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class CustomerProfilesTableTest {

    @Test
    void theLookupReadsOneProfileByItsCdpUuidWithOneParameter() {
        assertEquals("select \"fid\", \"cardcode\", \"customer_id\", \"phone\", \"email\", \"name\", \"first_name\", "
            + "\"pronoun\", \"gender\", \"age\", \"city\", \"env\", \"cdp_uuid\", \"network_user_id\", \"user_time\" "
            + "from \"customer_profiles\" where \"cdp_uuid\" = ? fetch next 1 rows only",
            CustomerProfilesTable.lookupSql(CustomerProfilesTable.COLUMNS));
    }

    @Test
    void aLookupForOneConditionFieldReadsOnlyItsColumn() {
        assertEquals("select \"city\" from \"customer_profiles\" where \"cdp_uuid\" = ? fetch next 1 rows only",
            CustomerProfilesTable.lookupSql(List.of(CustomerProfilesTable.columnOf("profile.city").orElseThrow())));
    }

    @Test
    void aConditionFieldNamesItsColumnWithEitherPrefix() {
        assertEquals(Optional.of("first_name"), CustomerProfilesTable.columnOf("profile.first_name"));
        assertEquals(Optional.of("city"), CustomerProfilesTable.columnOf("user.city"));
        assertEquals(Optional.empty(), CustomerProfilesTable.columnOf("profile.password"));
        assertEquals(Optional.empty(), CustomerProfilesTable.columnOf("city"));
    }
}
