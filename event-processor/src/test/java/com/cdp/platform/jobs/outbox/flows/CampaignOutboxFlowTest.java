package com.cdp.platform.jobs.outbox.flows;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.concurrent.CompletableFuture;

import org.apache.flink.streaming.api.functions.async.CollectionSupplier;
import org.apache.flink.streaming.api.functions.async.ResultFuture;

import com.cdp.platform.shared.db.repositories.UnreachableDatabase;
import com.cdp.platform.shared.models.Event;
import com.cdp.platform.shared.models.NotificationEvent;
import com.cdp.platform.shared.models.db.UserCampaignState;
import com.cdp.platform.shared.models.db.UserProfile;
import com.cdp.platform.shared.models.node.EngagementAction;
import com.cdp.platform.shared.models.node.NodeType;
import com.cdp.platform.shared.utils.JacksonMapper;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;

class CampaignOutboxFlowTest {

    /**
     * What studio's flattenCampaignTree writes for an SMS node: unset fields are
     * empty strings.
     */
    private static final String STUDIO_SMS_ACTION = "{\"type\":\"sms\",\"title\":\"\","
        + "\"body\":\"Your cart is waiting. Free shipping if you check out in 2 hours.\",\"subject\":\"\","
        + "\"url\":\"\",\"phone\":\"\",\"payload\":null,\"templateId\":\"\",\"method\":\"POST\"}";

    private static final String STUDIO_PUSH_ACTION_WITH_EVERY_FIELD = "{\"type\":\"push\","
        + "\"title\":\"Still thinking about it?\",\"body\":\"Your cart is waiting.\","
        + "\"subject\":\"Cart reminder\",\"url\":\"https://shop.example.com/cart\",\"phone\":\"\","
        + "\"payload\":{\"deep_link\":\"shop://cart\"},\"templateId\":\"CART_REMINDER_01\",\"method\":\"POST\"}";

    @Test
    void requestCarriesTheChannelAndEveryContentFieldOfTheAction() {
        JsonNode request = publish(engagementTransition(STUDIO_PUSH_ACTION_WITH_EVERY_FIELD));

        assertEquals("push", request.path("channel").asText());
        JsonNode content = request.path("content");
        assertEquals("Still thinking about it?", content.path("title").asText());
        assertEquals("Your cart is waiting.", content.path("body").asText());
        assertEquals("Cart reminder", content.path("subject").asText());
        assertEquals("https://shop.example.com/cart", content.path("url").asText());
        assertEquals("CART_REMINDER_01", content.path("template_id").asText());
        assertEquals(JacksonMapper.readTree("{\"deep_link\":\"shop://cart\"}"), content.path("payload"));
    }

    @Test
    void contentLeavesOutTheFieldsTheActionDoesNotSet() {
        JsonNode request = publish(engagementTransition(STUDIO_SMS_ACTION));

        assertEquals("sms", request.path("channel").asText());
        assertEquals(List.of("body"), fieldNames(request.path("content")));
        assertEquals("Your cart is waiting. Free shipping if you check out in 2 hours.",
            request.path("content").path("body").asText());
    }

    @Test
    void webPushIsPublishedUnderTheContractChannelName() {
        String webPushAction = "{\"type\":\"web-push\",\"title\":\"Push Notification\","
            + "\"body\":\"Click here to see more\",\"subject\":\"\",\"url\":\"\",\"phone\":\"\",\"payload\":null,"
            + "\"templateId\":\"\",\"method\":\"POST\"}";

        assertEquals("web_push", publish(engagementTransition(webPushAction)).path("channel").asText());
    }

    @Test
    void webhookPayloadIsPublishedAsStudioSavedIt() {
        String webhookAction = "{\"type\":\"webhook\",\"title\":\"\",\"body\":\"\",\"subject\":\"\","
            + "\"url\":\"https://example.com/webhook\",\"phone\":\"\","
            + "\"payload\":\"{\\\"event\\\":\\\"campaign_triggered\\\"}\",\"templateId\":\"\",\"method\":\"POST\"}";

        JsonNode content = publish(engagementTransition(webhookAction)).path("content");

        assertEquals(List.of("url", "payload", "method"), fieldNames(content));
        assertEquals("{\"event\":\"campaign_triggered\"}", content.path("payload").asText());
    }

    @Test
    void webhookRequestCarriesTheNodeMethodInUppercase() {
        String webhookAction = "{\"type\":\"webhook\",\"url\":\"https://example.com/webhook\",\"method\":\"put\"}";

        assertEquals("PUT", publish(engagementTransition(webhookAction)).path("content").path("method").asText());
    }

    @Test
    void webhookWithoutAMethodIsPublishedAsPost() {
        String webhookAction = "{\"type\":\"webhook\",\"url\":\"https://example.com/webhook\",\"method\":\"\"}";

        assertEquals("POST", publish(engagementTransition(webhookAction)).path("content").path("method").asText());
    }

    @Test
    void requestCarriesTheTransitionContextAsAnObject() {
        UserCampaignState transition = engagementTransition(STUDIO_SMS_ACTION,
            "{\"event.name\":\"add_to_cart\",\"product.price\":\"12990000\"}");

        assertEquals(JacksonMapper.readTree("{\"event.name\":\"add_to_cart\",\"product.price\":\"12990000\"}"),
            publish(transition).path("context"));
    }

    @Test
    void requestContextNamesAnEventAttributeAsTheConditionNamesIt() {
        Event priced = new Event("domain-1", "user-1", "view_product", 1_760_346_764_120L, null, null, null, null,
            "web", "{\"product\":{\"price\":10}}");
        UserCampaignState transition = engagementTransition(STUDIO_SMS_ACTION,
            JacksonMapper.writeValueAsString(priced.buildContext()));

        assertEquals(JacksonMapper.readTree("{\"event.name\":\"view_product\",\"product.price\":\"10\"}"),
            publish(transition).path("context"));
    }

    @Test
    void contextThatIsNotAJsonObjectIsLeftOutAndTheRequestStillPublishes() {
        JsonNode request = publish(engagementTransition(STUDIO_SMS_ACTION, "[\"add_to_cart\"]"));

        assertEquals("sms", request.path("channel").asText());
        assertFalse(request.has("context"));
    }

    @Test
    void requestLeavesOutEveryNullField() {
        JsonNode request = publish(engagementTransition(STUDIO_SMS_ACTION, null));

        assertEquals(List.of("schema_version", "metadata", "channel", "content", "profile"), fieldNames(request));
        assertEquals(List.of("campaign_id", "node_id", "execution_id", "generated_at"),
            fieldNames(request.path("metadata")));
        assertEquals(List.of("user_id", "domain_user_id"), fieldNames(request.path("profile")));
    }

    @Test
    void metadataNamesTheNodeSoThatASenderNeedNotParseTheExecutionId() {
        UserCampaignState transition = new UserCampaignState("canon-1", "domain-1", null, "user-1", "CAMP-0001",
            "first",
            "n5_sms", "next", 1_760_346_782_000L, NodeType.engagement, STUDIO_SMS_ACTION, "{}", List.of(), "event-1");

        JsonNode metadata = publish(transition).path("metadata");

        assertEquals("CAMP-0001", metadata.path("campaign_id").asText());
        assertEquals("n5_sms", metadata.path("node_id").asText());
        assertEquals("CAMP-0001_n5_sms_canon-1_first", metadata.path("execution_id").asText());
        assertEquals("2025-10-13T09:13:02Z", metadata.path("generated_at").asText());
    }

    @Test
    void profileLeavesOutTheDomainUserIdWhenTheTransitionHasNone() {
        UserCampaignState transitionWithoutDevice = new UserCampaignState("canon-1", null, null, "user-1",
            "CAMP-0001", "first", "n5_sms", "next", 1_760_346_782_000L, NodeType.engagement, STUDIO_SMS_ACTION, "{}",
            List.of(),
            "event-1");

        assertEquals(List.of("user_id"), fieldNames(publish(transitionWithoutDevice).path("profile")));
    }

    /**
     * The timed-out lookup must give its thread back, or later lookups wait behind
     * it and time out too.
     */
    @Test
    void profileLookupThatTimesOutIsCancelled() {
        CompletableFuture<UserProfile> lookup = new CompletableFuture<>();
        CollectingResultFuture result = new CollectingResultFuture(new ArrayList<>());
        CampaignOutboxFlow.ToNotificationEvent function = new CampaignOutboxFlow.ToNotificationEvent(
            (userId, canonId) -> lookup);

        function.asyncInvoke(engagementTransition(STUDIO_SMS_ACTION), result);
        function.timeout(engagementTransition(STUDIO_SMS_ACTION), result);

        assertTrue(lookup.isCancelled());
        assertEquals(1, result.published.size());
        assertNull(result.failure);
    }

    @Test
    void profileLookupThatTimesOutStillPublishesTheRequest() {
        List<NotificationEvent> published = new ArrayList<>();

        new CampaignOutboxFlow.ToNotificationEvent(UnreachableDatabase.CONFIG)
            .timeout(engagementTransition(STUDIO_SMS_ACTION), new CollectingResultFuture(published));

        assertEquals(1, published.size());
        JsonNode request = JacksonMapper.readTree(JacksonMapper.writeValueAsString(published.get(0)));
        assertEquals("sms", request.path("channel").asText());
        assertEquals(List.of("user_id", "domain_user_id"), fieldNames(request.path("profile")));
    }

    @Test
    void foundProfileIsPublishedWithTheRequest() {
        List<String> lookedUp = new ArrayList<>();
        CollectingResultFuture result = new CollectingResultFuture(new ArrayList<>());

        new CampaignOutboxFlow.ToNotificationEvent((userId, canonId) -> {
            lookedUp.add(userId + " " + canonId);
            return CompletableFuture.completedFuture(profileOfNguyenVanA());
        }).asyncInvoke(engagementTransition(STUDIO_SMS_ACTION), result);

        assertEquals(List.of("user-1 canon-1"), lookedUp);
        assertNull(result.failure);
        assertEquals(1, result.published.size());
        JsonNode profile = toJson(result.published.get(0)).path("profile");
        assertEquals("Nguyen Van A", profile.path("customer_name").asText());
        assertEquals("A", profile.path("first_name").asText());
        assertEquals("0912345678", profile.path("phone").asText());
        assertEquals("a@example.com", profile.path("email").asText());
    }

    /**
     * The request goes out without contact fields but keeps the transition's ids,
     * so that a web_push sender can still reach the browser.
     */
    @Test
    void profileLookupThatFailsPublishesOnlyTheTransitionIds() {
        CollectingResultFuture result = new CollectingResultFuture(new ArrayList<>());

        new CampaignOutboxFlow.ToNotificationEvent(
            (userId, canonId) -> CompletableFuture.failedFuture(new IllegalStateException("connection refused")))
            .asyncInvoke(engagementTransition(STUDIO_SMS_ACTION), result);

        assertNull(result.failure);
        assertEquals(1, result.published.size());
        JsonNode request = toJson(result.published.get(0));
        assertEquals("sms", request.path("channel").asText());
        assertEquals(List.of("user_id", "domain_user_id"), fieldNames(request.path("profile")));
        assertEquals("user-1", request.path("profile").path("user_id").asText());
        assertEquals("domain-1", request.path("profile").path("domain_user_id").asText());
    }

    @Test
    void transitionWhoseActionDoesNotParseIsDroppedWithoutFailingTheJob() {
        List<NotificationEvent> published = new ArrayList<>();

        assertDoesNotThrow(() -> new CampaignOutboxFlow.ToNotificationEvent(UnreachableDatabase.CONFIG)
            .asyncInvoke(engagementTransition("{\"type\":\"sms\",\"body\":"), new CollectingResultFuture(published)));

        assertEquals(List.of(), published);
    }

    @Test
    void webhookWithAnUnknownMethodIsDroppedWithoutFailingTheJob() {
        List<NotificationEvent> published = new ArrayList<>();
        String webhookAction = "{\"type\":\"webhook\",\"url\":\"https://example.com/webhook\",\"method\":\"FETCH\"}";

        assertDoesNotThrow(() -> new CampaignOutboxFlow.ToNotificationEvent(UnreachableDatabase.CONFIG)
            .asyncInvoke(engagementTransition(webhookAction), new CollectingResultFuture(published)));

        assertEquals(List.of(), published);
    }

    @Test
    void onlyAnEngagementTransitionWithAnActionGivesARequest() {
        assertTrue(CampaignOutboxFlow.isEngagementTransition(engagementTransition(STUDIO_SMS_ACTION)));
        assertFalse(CampaignOutboxFlow.isEngagementTransition(transition(NodeType.end, null)));
        assertFalse(CampaignOutboxFlow.isEngagementTransition(transition(NodeType.check, null)));
        assertFalse(CampaignOutboxFlow.isEngagementTransition(transition(NodeType.engagement, null)));
    }

    @Test
    void metadataNamesTheCampaignTheExecutionAndTheEventTime() {
        JsonNode metadata = publish(engagementTransition(STUDIO_SMS_ACTION)).path("metadata");

        assertEquals("CAMP-0001", metadata.path("campaign_id").asText());
        assertEquals("CAMP-0001_n5_sms_canon-1_first", metadata.path("execution_id").asText());
        assertEquals("2025-10-13T09:13:02Z", metadata.path("generated_at").asText());
    }

    @Test
    void theSameTransitionAlwaysGivesTheSameExecutionId() {
        JsonNode first = publish(engagementTransition(STUDIO_SMS_ACTION));
        JsonNode replayed = publish(engagementTransition(STUDIO_SMS_ACTION));

        assertEquals(first.path("metadata").path("execution_id"), replayed.path("metadata").path("execution_id"));
    }

    /**
     * A sender deduplicates on the execution id, so a person's two entries at one
     * engagement node must send two requests.
     */
    @Test
    void twoEntriesAtOneNodeGetTwoExecutionIds() {
        UserCampaignState firstDrop = new UserCampaignState("canon-1", "domain-1", null, "user-1", "CAMP-0001",
            "be-1", "n5_sms", "next", 1_760_346_782_000L, NodeType.engagement, STUDIO_SMS_ACTION, "{}", List.of(),
            "event-1");
        UserCampaignState secondDrop = new UserCampaignState("canon-1", "domain-1", null, "user-1", "CAMP-0001",
            "be-2", "n5_sms", "next", 1_760_346_782_000L, NodeType.engagement, STUDIO_SMS_ACTION, "{}", List.of(),
            "event-2");

        assertEquals(List.of("CAMP-0001_n5_sms_canon-1_be-1", "CAMP-0001_n5_sms_canon-1_be-2"),
            List
                .of(firstDrop, secondDrop)
                .stream()
                .map(transition -> publish(transition).path("metadata").path("execution_id").asText())
                .toList());
    }

    @Test
    void profileCarriesTheTransitionIdsAndTheFoundContactFields() {
        JsonNode profile = publish(engagementTransition(STUDIO_SMS_ACTION), profileOfNguyenVanA()).path("profile");

        assertEquals("user-1", profile.path("user_id").asText());
        assertEquals("domain-1", profile.path("domain_user_id").asText());
        assertEquals("Nguyen Van A", profile.path("customer_name").asText());
        assertEquals("A", profile.path("first_name").asText());
        assertEquals("anh", profile.path("pronoun").asText());
        assertEquals("male", profile.path("gender").asText());
        assertEquals("0912345678", profile.path("phone").asText());
        assertEquals("a@example.com", profile.path("email").asText());
    }

    @Test
    void profileUserIdFallsBackToTheCustomerIdWhenTheTransitionHasNone() {
        UserCampaignState anonymous = new UserCampaignState("canon-1", "domain-1", null, null, "CAMP-0001", "first",
            "n5_sms", "next", 1_760_346_782_000L, NodeType.engagement, STUDIO_SMS_ACTION, "{}", List.of(), "event-1");

        assertEquals("customer-9",
            publish(anonymous, profileWithCustomerId("customer-9")).path("profile").path("user_id").asText());
    }

    /** A blank user_id is looked up by canon_id, as a missing one is. */
    @Test
    void profileUserIdFallsBackToTheCustomerIdWhenTheTransitionUserIdIsBlank() {
        UserCampaignState blankUserId = new UserCampaignState("canon-1", "domain-1", null, " ", "CAMP-0001", "first",
            "n5_sms", "next", 1_760_346_782_000L, NodeType.engagement, STUDIO_SMS_ACTION, "{}", List.of(), "event-1");

        assertEquals("customer-9",
            publish(blankUserId, profileWithCustomerId("customer-9")).path("profile").path("user_id").asText());
    }

    private static JsonNode publish(UserCampaignState transition) {
        return publish(transition, UserProfile.empty());
    }

    private static JsonNode publish(UserCampaignState transition, UserProfile profile) {
        EngagementAction action = EngagementAction.parse(transition.actionJson()).valueOrThrow();
        return JacksonMapper
            .readTree(JacksonMapper
                .writeValueAsString(CampaignOutboxFlow.toNotificationEvent(transition, action, profile)));
    }

    private static UserProfile profileWithCustomerId(String customerId) {
        return new UserProfile(1L, null, customerId, null, null, null, null, null, null, null, null, null, null,
            null, null);
    }

    private static UserCampaignState transition(NodeType nodeType, String actionJson) {
        return new UserCampaignState("canon-1", "domain-1", null, "user-1", "CAMP-0001", "first", "n5", "next",
            1_760_346_782_000L, nodeType, actionJson, "{}", List.of(), "event-1");
    }

    private static JsonNode toJson(NotificationEvent request) {
        return JacksonMapper.readTree(JacksonMapper.writeValueAsString(request));
    }

    private static UserProfile profileOfNguyenVanA() {
        return new UserProfile(1L, null, null, "0912345678", "a@example.com", "Nguyen Van A", "A", "anh", "male",
            null, null, null, "user-1", null, null);
    }

    private static UserCampaignState engagementTransition(String actionJson) {
        return engagementTransition(actionJson, "{}");
    }

    private static UserCampaignState engagementTransition(String actionJson, String contextJson) {
        return new UserCampaignState("canon-1", "domain-1", null, "user-1", "CAMP-0001", "first", "n5_sms", "next",
            1_760_346_782_000L, NodeType.engagement, actionJson, contextJson, List.of(), "event-1");
    }

    private static final class CollectingResultFuture implements ResultFuture<NotificationEvent> {
        private final List<NotificationEvent> published;
        private Throwable failure;
        private boolean completed;

        CollectingResultFuture(List<NotificationEvent> published) {
            this.published = published;
        }

        @Override
        public void complete(Collection<NotificationEvent> result) {
            published.addAll(result);
            completed = true;
        }

        @Override
        public void complete(CollectionSupplier<NotificationEvent> supplier) {
            try {
                published.addAll(supplier.get());
                completed = true;
            } catch (Exception exception) {
                throw new IllegalStateException(exception);
            }
        }

        @Override
        public void completeExceptionally(Throwable error) {
            failure = error;
        }
    }

    private static List<String> fieldNames(JsonNode node) {
        return node.properties().stream().map(entry -> entry.getKey()).toList();
    }
}
