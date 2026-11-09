import {
  appendEventAttributeChild,
  buildEventAttributeTree,
  createUniqueEventAttributePath,
  flattenEventAttributeTree,
  isEventAttributeInSubtree,
  normalizeEventAttributePath,
  renameEventAttribute,
} from "../eventAttributeTree";

const attribute = (value: string, dataType = "string") => ({ value, dataType });

describe("attribute paths", () => {
  it("trims each key and drops empty ones when it reads a stored path", () => {
    expect(normalizeEventAttributePath(" product . price ")).toBe("product.price");
    expect(normalizeEventAttributePath("a..b")).toBe("a.b");
  });

  it("appends a child key under its parent", () => {
    expect(appendEventAttributeChild("product", " price ")).toBe("product.price");
    expect(appendEventAttributeChild("", "quantity")).toBe("quantity");
  });

  it("knows which paths belong to a subtree, and not to a longer sibling", () => {
    expect(isEventAttributeInSubtree("product.price", "product")).toBe(true);
    expect(isEventAttributeInSubtree("product", "product")).toBe(true);
    expect(isEventAttributeInSubtree("product_old.price", "product")).toBe(false);
  });

  it("picks a new attribute key that no sibling has", () => {
    const attributes = [attribute("new_attribute"), attribute("new_attribute_2"), attribute("product.new_attribute")];
    expect(createUniqueEventAttributePath(attributes)).toBe("new_attribute_3");
    expect(createUniqueEventAttributePath(attributes, "product")).toBe("product.new_attribute_2");
  });
});

describe("the attribute tree", () => {
  it("nests attributes by path and orders siblings by key", () => {
    const tree = buildEventAttributeTree([
      attribute("quantity", "number"),
      attribute("product", "json"),
      attribute("product.price", "number"),
      attribute("product.id"),
    ]);

    expect(flattenEventAttributeTree(tree).map(({ node, depth }) => [node.path, depth])).toEqual([
      ["product", 0],
      ["product.id", 1],
      ["product.price", 1],
      ["quantity", 0],
    ]);
  });

  it("shows a parent that has no attribute of its own as a group", () => {
    const tree = buildEventAttributeTree([attribute("product.price", "number")]);
    expect(tree.children[0]).toMatchObject({ path: "product", attribute: null });
  });
});

describe("renaming an attribute (CAT-FR-04)", () => {
  const attributes = [
    attribute("product", "json"),
    attribute("product.id"),
    attribute("product.price", "number"),
    attribute("product_old"),
    attribute("quantity", "number"),
  ];

  it("rewrites the path of every descendant: product renamed to item makes product.price item.price", () => {
    expect(renameEventAttribute(attributes, "product", "item").map((a) => a.value)).toEqual([
      "item",
      "item.id",
      "item.price",
      "product_old",
      "quantity",
    ]);
  });

  it("keeps the other fields of each attribute", () => {
    expect(renameEventAttribute(attributes, "product.price", "amount")[2]).toEqual(attribute("product.amount", "number"));
  });

  it.each([
    ["an empty key", " ", "An attribute key cannot be empty."],
    ["a dotted key", "a.b", 'The key "a.b" contains a dot. Add a child attribute instead.'],
    ["the key of a sibling", "quantity", 'An attribute with the path "quantity" already exists.'],
    ["the key of a nested sibling", "id", 'An attribute with the path "product.id" already exists.'],
  ])("refuses %s", (_case, key, message) => {
    const path = key === "id" ? "product.price" : "product";
    expect(() => renameEventAttribute(attributes, path, key)).toThrow(message);
  });

  it("allows a rename to the same key", () => {
    expect(renameEventAttribute(attributes, "quantity", " quantity ")).toEqual(attributes);
  });
});
