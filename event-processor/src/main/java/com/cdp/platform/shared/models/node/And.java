package com.cdp.platform.shared.models.node;

import java.util.List;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

@JsonIgnoreProperties(ignoreUnknown = true)
public record And(@JsonProperty("expressions") List<Predicate> expressions) implements Predicate {
}
