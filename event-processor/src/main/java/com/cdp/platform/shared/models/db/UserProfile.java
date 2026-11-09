package com.cdp.platform.shared.models.db;

import com.cdp.platform.shared.models.node.FieldPredicates;
import com.cdp.platform.shared.models.node.Predicate;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Domain record representing a row in the user_profiles table.
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
    @JsonProperty("userTime") String userTime) {
    public static UserProfile empty() {
        return new UserProfile(null, null, null, null, null, null, null, null, null, null, null, null, null, null,
            null);
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
            default -> null;
        };
    }

    /**
     * Evaluate a profile-specific predicate tree against this user's attributes.
     * New predicates use {@code profile.*} field references. The legacy
     * {@code user.*} prefix remains readable for existing campaigns.
     */
    public boolean evalPredicate(Predicate pred) {
        return FieldPredicates.evaluate(pred, this::getField);
    }
}
