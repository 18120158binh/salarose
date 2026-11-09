package com.cdp.platform.shared.models.node;

/**
 * Passes when its expression fails. Only the job builds it, for the profile
 * condition left of a {@code not_in} segment membership, so no saved document
 * can name it.
 */
public record Not(Predicate expression) implements Predicate {
}
