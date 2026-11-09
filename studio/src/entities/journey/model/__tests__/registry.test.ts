import {
  RUNTIME_REGISTRY,
  hasOption,
  offersConditionType,
  offersMeasure,
  offersTrigger,
  type RuntimeRegistry,
} from "@/entities/journey/model/registry";

const everyEntryOnline: RuntimeRegistry = RUNTIME_REGISTRY.map((entry) => ({ ...entry, online: true }));

// JBD-FR-31
describe("the runtime registry", () => {
  it("offers the start set", () => {
    expect([
      offersTrigger(RUNTIME_REGISTRY, "event"),
      offersConditionType(RUNTIME_REGISTRY, "event_property"),
      offersConditionType(RUNTIME_REGISTRY, "profile_property"),
      offersConditionType(RUNTIME_REGISTRY, "behavior"),
    ]).toEqual([true, true, true, true]);
  });

  it("holds each of the six later entries offline", () => {
    expect([
      offersConditionType(RUNTIME_REGISTRY, "segment_membership"),
      offersTrigger(RUNTIME_REGISTRY, "segment_entry"),
      hasOption(RUNTIME_REGISTRY, "segment_mode_event_filters"),
      hasOption(RUNTIME_REGISTRY, "size_from_tracked_members"),
      hasOption(RUNTIME_REGISTRY, "size_with_imported_members"),
      hasOption(RUNTIME_REGISTRY, "include_current_members"),
    ]).toEqual([false, false, false, false, false, false]);
  });

  it("offers an entry once it comes online", () => {
    expect([
      offersConditionType(everyEntryOnline, "segment_membership"),
      offersTrigger(everyEntryOnline, "segment_entry"),
      hasOption(everyEntryOnline, "include_current_members"),
    ]).toEqual([true, true, true]);
  });

  it("never offers business_event, whatever the registry holds", () => {
    expect(offersTrigger(RUNTIME_REGISTRY, "business_event")).toBe(false);
    expect(offersTrigger(everyEntryOnline, "business_event")).toBe(false);
  });

  it("offers every measure to a new condition but INACTION", () => {
    expect(["COUNT", "SUM", "INACTION"].map(offersMeasure)).toEqual([true, true, false]);
  });
});
