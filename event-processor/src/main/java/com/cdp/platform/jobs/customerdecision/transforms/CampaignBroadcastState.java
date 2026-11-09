package com.cdp.platform.jobs.customerdecision.transforms;

import org.apache.flink.api.common.state.BroadcastState;
import org.apache.flink.types.Either;
import org.apache.flink.types.Row;
import org.apache.flink.types.RowKind;

import com.cdp.platform.shared.db.repositories.CampaignsTable;
import com.cdp.platform.shared.models.db.Campaign;
import com.cdp.platform.shared.models.db.CampaignNode;

/**
 * Applies campaign and node rows from CDC to broadcast state. An update's
 * before
 * image is skipped: the state key is the row's primary key, which an update
 * never
 * changes, so removing the entry until the after image arrives would only hide
 * the rule from the events in between. A key change reaches CDC as a delete and
 * an insert.
 */
final class CampaignBroadcastState {

    private CampaignBroadcastState() {
    }

    static void apply(
        Either<Row, Row> update,
        BroadcastState<String, Campaign> campaigns,
        BroadcastState<String, CampaignNode> nodes) throws Exception {
        if (update.isLeft()) {
            updateCampaign(update.left(), campaigns);
        } else {
            updateNode(update.right(), nodes);
        }
    }

    private static void updateCampaign(Row row, BroadcastState<String, Campaign> campaigns) throws Exception {
        if (row.getKind() == RowKind.UPDATE_BEFORE) return;
        String campaignId = row.getFieldAs(CampaignsTable.ID);
        if (row.getKind() == RowKind.DELETE) {
            campaigns.remove(campaignId);
            return;
        }
        var campaign = Campaign.load(row);
        if (campaign.isPresent()) {
            campaigns.put(campaignId, campaign.get());
        } else {
            campaigns.remove(campaignId);
        }
    }

    private static void updateNode(Row row, BroadcastState<String, CampaignNode> nodes) throws Exception {
        if (row.getKind() == RowKind.UPDATE_BEFORE) return;
        String stateKey = CampaignNode.stateKey(row);
        if (row.getKind() == RowKind.DELETE) {
            nodes.remove(stateKey);
            return;
        }

        var node = CampaignNode.load(row);
        if (node.isPresent()) {
            nodes.put(stateKey, node.get());
        } else {
            nodes.remove(stateKey);
        }
    }
}
