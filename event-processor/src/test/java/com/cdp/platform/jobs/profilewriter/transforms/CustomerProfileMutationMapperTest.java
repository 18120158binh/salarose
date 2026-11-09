package com.cdp.platform.jobs.profilewriter.transforms;

import java.util.ArrayList;
import java.util.List;

import org.apache.flink.api.common.functions.util.ListCollector;

import com.cdp.platform.shared.models.MetricBucket;
import com.cdp.platform.shared.models.MetricBucket.Size;
import com.cdp.platform.shared.models.db.UserMetric;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class CustomerProfileMutationMapperTest {

    private static final MetricBucket SUM_BUCKET = new MetricBucket(Size.MINUTE, 0L, 2, 8.0, 2L, null, null, null,
        null, null);
    private static final MetricBucket COUNT_BUCKET = new MetricBucket(Size.MINUTE, 60_000L, 1, null, null, null, null,
        null, null, null);

    private static List<UserMetric> parse(String json) {
        List<UserMetric> rows = new ArrayList<>();
        new CustomerProfileMutationMapper().flatMap(json, new ListCollector<>(rows));
        return rows;
    }

    @Test
    void validMutationBecomesOneRowPerMetric() {
        List<UserMetric> rows = parse("""
            {"schemaVersion":1,"canonId":"customer-42","behaviorVersion":18,"eventId":"e1","eventTime":2000,"metrics":[
              {"metricId":"m_purchase_total","valueType":"number","seriesClock":2000,"buckets":[
                {"size":"MINUTE","start":0,"count":2,"sum":8.0,"valueCount":2}]}]}
            """);

        assertEquals(List.of(new UserMetric("customer-42", "m_purchase_total", 2000L, List.of(SUM_BUCKET), 18L)), rows);
    }

    @Test
    void eachMetricOfAMutationIsStoredAtTheMutationsBehaviorVersion() {
        List<UserMetric> rows = parse("""
            {"schemaVersion":1,"canonId":"customer-42","behaviorVersion":18,"eventId":"e1","eventTime":2000,"metrics":[
              {"metricId":"m_purchase_total","valueType":"NUMBER","seriesClock":2000,"buckets":[
                {"size":"MINUTE","start":0,"count":2,"sum":8.0,"valueCount":2}]},
              {"metricId":"m_view_product_count","valueType":"PRESENCE","seriesClock":60000,"buckets":[
                {"size":"MINUTE","start":60000,"count":1}]}]}
            """);

        assertEquals(List
            .of(new UserMetric("customer-42", "m_purchase_total", 2000L, List.of(SUM_BUCKET), 18L),
                new UserMetric("customer-42", "m_view_product_count", 60_000L, List.of(COUNT_BUCKET), 18L)),
            rows);
    }

    @Test
    void metricWithoutAKnownValueTypeIsDroppedAndTheOthersAreKept() {
        List<UserMetric> rows = parse("""
            {"schemaVersion":1,"canonId":"customer-42","behaviorVersion":18,"eventId":"e1","eventTime":2000,"metrics":[
              {"metricId":"m_purchase_count","seriesClock":0,"buckets":[{"size":"MINUTE","start":0,"count":1}]},
              {"metricId":"m_purchase_total","valueType":"MONEY","seriesClock":0,"buckets":[
                {"size":"MINUTE","start":0,"count":1}]},
              {"metricId":"m_view_count","valueType":"PRESENCE","seriesClock":60000,"buckets":[
                {"size":"MINUTE","start":60000,"count":1}]}]}
            """);

        assertEquals(List.of(new UserMetric("customer-42", "m_view_count", 60_000L, List.of(COUNT_BUCKET), 18L)), rows);
    }

    @Test
    void mutationWithFieldsThisWriterDoesNotKnowIsStored() {
        List<UserMetric> rows = parse("""
            {"schemaVersion":1,"canonId":"customer-42","behaviorVersion":18,"eventId":"e1","eventTime":2000,
             "source":"web","metrics":[
              {"metricId":"m_purchase_total","valueType":"NUMBER","unit":"VND","seriesClock":2000,"buckets":[
                {"size":"MINUTE","start":0,"count":2,"sum":8.0,"valueCount":2,"context":{"page":"/checkout"}}]}]}
            """);

        assertEquals(List.of(new UserMetric("customer-42", "m_purchase_total", 2000L, List.of(SUM_BUCKET), 18L)), rows);
    }

    @Test
    void messageThatIsNotJsonIsDropped() {
        assertEquals(List.of(), parse("not json"));
    }

    @Test
    void messageThatIsJsonNullIsDropped() {
        assertEquals(List.of(), parse("null"));
    }

    @Test
    void mutationWithoutCanonIdIsDropped() {
        List<UserMetric> rows = parse("""
            {"schemaVersion":1,"behaviorVersion":18,"eventId":"e1","eventTime":2000,"metrics":[
              {"metricId":"m_view_count","valueType":"PRESENCE","seriesClock":60000,"buckets":[
                {"size":"MINUTE","start":60000,"count":1}]}]}
            """);

        assertEquals(List.of(), rows);
    }

    @Test
    void mutationWithoutBehaviorVersionIsDropped() {
        List<UserMetric> rows = parse("""
            {"schemaVersion":1,"canonId":"customer-42","eventId":"e1","eventTime":2000,"metrics":[
              {"metricId":"m_view_count","valueType":"PRESENCE","seriesClock":60000,"buckets":[
                {"size":"MINUTE","start":60000,"count":1}]}]}
            """);

        assertEquals(List.of(), rows);
    }

    @Test
    void metricWithoutMetricIdIsDroppedAndTheOthersAreKept() {
        List<UserMetric> rows = parse("""
            {"schemaVersion":1,"canonId":"customer-42","behaviorVersion":18,"eventId":"e1","eventTime":2000,"metrics":[
              {"valueType":"PRESENCE","seriesClock":0,"buckets":[{"size":"MINUTE","start":0,"count":1}]},
              {"metricId":"m_view_count","valueType":"PRESENCE","seriesClock":60000,"buckets":[
                {"size":"MINUTE","start":60000,"count":1}]}]}
            """);

        assertEquals(List.of(new UserMetric("customer-42", "m_view_count", 60_000L, List.of(COUNT_BUCKET), 18L)), rows);
    }

    @Test
    void metricWithABucketWithoutSizeIsDroppedAndTheOthersAreKept() {
        List<UserMetric> rows = parse("""
            {"schemaVersion":1,"canonId":"customer-42","behaviorVersion":18,"eventId":"e1","eventTime":2000,"metrics":[
              {"metricId":"m_purchase_count","valueType":"PRESENCE","seriesClock":0,"buckets":[
                {"start":0,"count":1}]},
              {"metricId":"m_view_count","valueType":"PRESENCE","seriesClock":60000,"buckets":[
                {"size":"MINUTE","start":60000,"count":1}]}]}
            """);

        assertEquals(List.of(new UserMetric("customer-42", "m_view_count", 60_000L, List.of(COUNT_BUCKET), 18L)), rows);
    }

    @Test
    void metricWithAnEmptyBucketIsDroppedAndTheOthersAreKept() {
        List<UserMetric> rows = parse("""
            {"schemaVersion":1,"canonId":"customer-42","behaviorVersion":18,"eventId":"e1","eventTime":2000,"metrics":[
              {"metricId":"m_purchase_count","valueType":"PRESENCE","seriesClock":0,"buckets":[
                {"size":"MINUTE","start":0,"count":0}]},
              {"metricId":"m_view_count","valueType":"PRESENCE","seriesClock":60000,"buckets":[
                {"size":"MINUTE","start":60000,"count":1}]}]}
            """);

        assertEquals(List.of(new UserMetric("customer-42", "m_view_count", 60_000L, List.of(COUNT_BUCKET), 18L)), rows);
    }
}
