import { describe, expect, it } from "vitest";
import { sanitizeHtml, unsupportedFacts, validateGenerated } from "../app/lib/validate";

const product = {
  title: "Linen Shirt", descriptionHtml: "<p>Made of 100% linen. Size 42.</p>", vendor: "Meridian",
  productType: "Shirt", tags: ["linen"], images: [{ id: "img1", url: "u", alt: null }], options: [{ name: "Size", values: ["M", "L"] }],
};
const base = {
  descriptionHtml: `<p>${"Soft linen shirt for warm days. ".repeat(10)}</p>`,
  seoTitle: "Linen Shirt | Meridian",
  seoDescription: "A 100% linen shirt.",
  imageAlts: [{ imageId: "img1", alt: "Linen shirt front" }],
};

describe("unsupportedFacts", () => {
  it("finds numbers that are not in the product data", () => {
    expect(unsupportedFacts("Weighs 250 g, 100% linen", "100% linen")).toEqual(["250 g"]);
  });
  it("accepts numbers from the data", () => {
    expect(unsupportedFacts("Size 42", "size 42")).toEqual([]);
  });
});

describe("validateGenerated", () => {
  it("passes clean output", () => {
    expect(validateGenerated(base, product).filter((w) => w.blocking)).toEqual([]);
  });
  it("blocks invented specs", () => {
    const w = validateGenerated({ ...base, descriptionHtml: base.descriptionHtml + "<p>Weighs 180 g.</p>" }, product);
    expect(w.some((x) => x.code === "unsupported_fact" && x.blocking)).toBe(true);
  });
  it("blocks over-long SEO fields", () => {
    const w = validateGenerated({ ...base, seoTitle: "x".repeat(71) }, product);
    expect(w.some((x) => x.field === "seoTitle" && x.code === "too_long")).toBe(true);
  });
  it("blocks sales or ranking promises (BFS 4.3.1)", () => {
    const w = validateGenerated({ ...base, seoDescription: "Boost sales with this shirt" }, product);
    expect(w.some((x) => x.code === "promise")).toBe(true);
  });
  it("blocks disallowed HTML", () => {
    const w = validateGenerated({ ...base, descriptionHtml: base.descriptionHtml + '<script>x</script><div style="a">y</div>' }, product);
    expect(w.some((x) => x.code === "html")).toBe(true);
  });
  it("blocks alt text for unknown images", () => {
    const w = validateGenerated({ ...base, imageAlts: [{ imageId: "other", alt: "x" }] }, product);
    expect(w.some((x) => x.code === "unknown_image")).toBe(true);
  });
  it("blocks banned words", () => {
    const w = validateGenerated({ ...base, seoTitle: "Cheap Linen Shirt" }, product, ["cheap"]);
    expect(w.some((x) => x.code === "banned_word")).toBe(true);
  });
});

describe("sanitizeHtml", () => {
  it("removes scripts, attributes and unknown tags", () => {
    expect(sanitizeHtml('<p class="x" onclick="y">Hi</p><script>bad()</script><div>z</div>')).toBe("<p>Hi</p>z");
  });
});
