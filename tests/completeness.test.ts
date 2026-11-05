import { describe, expect, it } from "vitest";
import { scoreProduct } from "../app/lib/completeness";

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

describe("scoreProduct", () => {
  it("scores an empty product low and lists what is missing", () => {
    const r = scoreProduct({ title: "Mug", descriptionHtml: "", images: [] });
    expect(r.score).toBe(0);
    expect(r.missing).toContain("description");
    expect(r.missing).toContain("images");
  });
  it("scores a complete product 100", () => {
    const r = scoreProduct({
      title: "Mug", descriptionHtml: `<p>${words(60)}</p>`, seoTitle: "Mug", seoDescription: "A mug",
      images: [{ id: "1", url: "u", alt: "Mug" }], productType: "Kitchen", tags: ["mug"],
    });
    expect(r).toEqual({ score: 100, missing: [] });
  });
  it("requires alt on every image", () => {
    const r = scoreProduct({ title: "Mug", descriptionHtml: "", images: [{ id: "1", url: "u", alt: "a" }, { id: "2", url: "u", alt: null }] });
    expect(r.missing).toContain("imageAlt");
  });
});
