package com.cdp.platform.shared.models.db;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class CampaignTest {

    @Test
    void campaignIsActiveOnlyWithTheStatusStudioWritesForIt() {
        assertTrue(campaign("active").isActive());
        assertFalse(campaign("paused").isActive());
        assertFalse(campaign("LIVE").isActive());
        assertFalse(campaign("live").isActive());
        assertFalse(campaign("ACTIVE").isActive());
    }

    private static Campaign campaign(String status) {
        return new Campaign("CAMP-0001", "Cart recovery", null, status, null, null, null, null);
    }
}
