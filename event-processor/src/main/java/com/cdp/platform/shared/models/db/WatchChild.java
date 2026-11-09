package com.cdp.platform.shared.models.db;

import com.cdp.platform.shared.models.node.Branch;
import com.cdp.platform.shared.models.node.WatchLimit;

/**
 * A watch node that a completed node leads to, as the transition lists it for
 * the timer flow: the watch's limit, the branch its deadline completes it on,
 * and the version of the graph that listed it. The limit was parsed when the
 * watch's row loaded, so neither the state machine nor the timer flow parses it
 * again.
 */
public record WatchChild(String nodeId, WatchLimit limit, Branch deadlineBranch, long graphVersion) {

    /**
     * The watch's deadline when its parent completed at {@code parentCompletedAt}.
     */
    public long deadlineAfter(long parentCompletedAt) {
        return limit.deadlineAfter(parentCompletedAt);
    }
}
