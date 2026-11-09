/** @jest-environment node */
import { bearerKey, generateSourceKey, hashSourceKey, parseAppId } from "../sourceKeys";

describe("source keys", () => {
  it("gives each new key a hash that matches it and a hint that does not reveal it", () => {
    const first = generateSourceKey();
    const second = generateSourceKey();

    expect(first.key).not.toBe(second.key);
    expect(first.hash).toBe(hashSourceKey(first.key));
    expect(first.hash).not.toContain(first.key);
    expect(first.key.startsWith(first.hint)).toBe(true);
    expect(first.hint.length).toBeLessThan(first.key.length - 32);
  });

  it("reads a bearer key and refuses any other header", () => {
    expect(bearerKey("Bearer cdp_sk_abc")).toBe("cdp_sk_abc");
    expect(bearerKey("Basic abc")).toBeNull();
    expect(bearerKey("Bearer ")).toBeNull();
    expect(bearerKey(null)).toBeNull();
  });

  it("takes a lower-case app id and refuses others", () => {
    expect(parseAppId(" inventory-service ")).toBe("inventory-service");
    expect(() => parseAppId("Inventory Service")).toThrow("The app id must be");
    expect(() => parseAppId("")).toThrow("The app id must be");
  });
});
