package com.cdp.platform.jobs.customerdecision.transforms;

import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.api.java.typeutils.PojoTypeInfo;

import com.cdp.platform.shared.models.db.UserProfile;

import static org.junit.jupiter.api.Assertions.assertInstanceOf;

import org.junit.jupiter.api.Test;

/**
 * The order operator keeps early decisions, with their profiles, in state. Both
 * types must stay POJOs, whose serializer restores a savepoint written before a
 * field was added, such as a profile's imported fields, with that field null.
 */
class DecisionStateSchemaTest {

    @Test
    void aDecisionAndItsProfileAreSerializedAsPojosSoAnAddedFieldRestores() {
        assertInstanceOf(PojoTypeInfo.class, TypeInformation.of(Decision.class));
        assertInstanceOf(PojoTypeInfo.class, TypeInformation.of(UserProfile.class));
    }
}
