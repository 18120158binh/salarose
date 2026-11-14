package com.cdp.platform.jobs.profilewriter;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;

class CustomerProfileWriterJobTest {

    @Test
    void theMembershipSinkWritesAtMost1000RowsASecondByDefault() {
        assertEquals(1_000, CustomerProfileWriterJob.segmentMembersMaxRowsPerSecond(null));
        assertEquals(1_000, CustomerProfileWriterJob.segmentMembersMaxRowsPerSecond(" "));
    }

    @Test
    void theCapIsConfigurable() {
        assertEquals(250, CustomerProfileWriterJob.segmentMembersMaxRowsPerSecond("250"));
    }

    @Test
    void anInvalidCapStopsTheJobAtStart() {
        assertThrows(IllegalArgumentException.class,
            () -> CustomerProfileWriterJob.segmentMembersMaxRowsPerSecond("fast"));
        assertThrows(IllegalArgumentException.class,
            () -> CustomerProfileWriterJob.segmentMembersMaxRowsPerSecond("0"));
        assertThrows(IllegalArgumentException.class,
            () -> CustomerProfileWriterJob.segmentMembersMaxRowsPerSecond("-5"));
        assertThrows(IllegalArgumentException.class,
            () -> CustomerProfileWriterJob.segmentMembersMaxRowsPerSecond("Infinity"));
    }
}
