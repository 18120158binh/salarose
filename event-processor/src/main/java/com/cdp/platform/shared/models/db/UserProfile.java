package com.cdp.platform.shared.models.db;

import java.time.Instant;
import java.util.Map;

import com.cdp.platform.shared.models.node.FieldPredicates;
import com.cdp.platform.shared.models.node.Predicate;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * The fields of a person's profile that a lookup read: the built-in fields of
 * {@code customer_profiles}, and the imported fields of
 * {@code customer_attributes}, keyed {@code <source>.<name>} such as
 * {@code orders.spend_90d} (DEC-FR-40).
 */
public record UserProfile(
    @JsonProperty("fid") Long fid,
    @JsonProperty("cardcode") String cardcode,
    @JsonProperty("customerId") String customerId,
    @JsonProperty("phone") String phone,
    @JsonProperty("email") String email,
    @JsonProperty("name") String name,
    @JsonProperty("firstName") String firstName,
    @JsonProperty("pronoun") String pronoun,
    @JsonProperty("gender") String gender,
    @JsonProperty("age") Double age,
    @JsonProperty("city") String city,
    @JsonProperty("env") String env,
    @JsonProperty("cdpUuid") String cdpUuid,
    @JsonProperty("networkUserId") String networkUserId,
    @JsonProperty("userTime") String userTime,
    @JsonProperty("imported") Map<String, String> imported) {

    private static final String PROFILE_PREFIX = "profile.";

    /** A profile without imported fields. */
    public UserProfile(Long fid, String cardcode, String customerId, String phone, String email, String name,
        String firstName, String pronoun, String gender, Double age, String city, String env, String cdpUuid,
        String networkUserId, String userTime) {
        this(fid, cardcode, customerId, phone, email, name, firstName, pronoun, gender, age, city, env, cdpUuid,
            networkUserId, userTime, Map.of());
    }

    public static UserProfile empty() {
        return new UserProfile(null, null, null, null, null, null, null, null, null, null, null, null, null, null,
            null);
    }

    /** This profile with the given imported fields in place of its own. */
    public UserProfile withImported(Map<String, String> fields) {
        return new UserProfile(fid, cardcode, customerId, phone, email, name, firstName, pronoun, gender, age, city,
            env, cdpUuid, networkUserId, userTime, Map.copyOf(fields));
    }

    public String getField(String key) {
        return switch (key) {
            case "profile.fid", "user.fid" -> fid != null ? String.valueOf(fid) : null;
            case "profile.cardcode", "user.cardcode" -> cardcode;
            case "profile.customer_id", "user.customer_id" -> customerId;
            case "profile.phone", "user.phone" -> phone;
            case "profile.email", "user.email" -> email;
            case "profile.name", "user.name" -> name;
            case "profile.first_name", "user.first_name" -> firstName;
            case "profile.pronoun", "user.pronoun" -> pronoun;
            case "profile.gender", "user.gender" -> gender;
            case "profile.age", "user.age" -> age != null ? String.valueOf(age) : null;
            case "profile.city", "user.city" -> city;
            case "profile.env", "user.env" -> env;
            case "profile.cdp_uuid", "user.cdp_uuid" -> cdpUuid;
            case "profile.network_user_id", "user.network_user_id" -> networkUserId;
            case "profile.user_time", "user.user_time" -> userTime;
            default -> importedField(key);
        };
    }

    // An imported field is the dotted name after the profile prefix. A built-in
    // name has no dot, so the two never meet.
    private String importedField(String key) {
        if (imported == null || key == null || !key.startsWith(PROFILE_PREFIX)) return null;
        return imported.get(key.substring(PROFILE_PREFIX.length()));
    }

    /**
     * Evaluate a profile-specific predicate tree against this user's attributes.
     * New predicates use {@code profile.*} field references. The legacy
     * {@code user.*} prefix remains readable for existing campaigns.
     */
    public boolean evalPredicate(Predicate pred) {
        return FieldPredicates.evaluate(pred, this::getField);
    }

    /**
     * Evaluates the tree as {@link #evalPredicate(Predicate)} does, measuring a
     * relative-date comparison from {@code checkTime}: the event's time, or the
     * segment check's {@code event_time} (DEC-FR-42).
     */
    public boolean evalPredicate(Predicate pred, Instant checkTime) {
        return FieldPredicates.evaluate(pred, this::getField, checkTime);
    }
}
