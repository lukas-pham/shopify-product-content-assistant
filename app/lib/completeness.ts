/**
 * Completeness score (0-100) for one product. Pure function — unit tested.
 * Weights reflect what a shopper and a search engine need first.
 */

export interface ProductFacts {
  title: string;
  descriptionHtml: string;
  seoTitle?: string | null;
  seoDescription?: string | null;
  images: { id: string; url: string; alt: string | null }[];
  productType?: string;
  vendor?: string;
  tags?: string[];
}

export const CHECKS = [
  { key: "description", label: "Description (at least 50 words)", weight: 35 },
  { key: "seoTitle", label: "SEO title", weight: 15 },
  { key: "seoDescription", label: "SEO description", weight: 15 },
  { key: "imageAlt", label: "Alt text on every image", weight: 15 },
  { key: "images", label: "At least one image", weight: 10 },
  { key: "productType", label: "Product type", weight: 5 },
  { key: "tags", label: "Tags", weight: 5 },
] as const;

export type CheckKey = (typeof CHECKS)[number]["key"];

export const stripHtml = (html: string) =>
  html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

export const wordCount = (text: string) => (text ? text.split(/\s+/).filter(Boolean).length : 0);

export function scoreProduct(p: ProductFacts): { score: number; missing: CheckKey[] } {
  const ok: Record<CheckKey, boolean> = {
    description: wordCount(stripHtml(p.descriptionHtml)) >= 50,
    seoTitle: !!p.seoTitle?.trim(),
    seoDescription: !!p.seoDescription?.trim(),
    imageAlt: p.images.length > 0 && p.images.every((i) => !!i.alt?.trim()),
    images: p.images.length > 0,
    productType: !!p.productType?.trim(),
    tags: (p.tags?.length ?? 0) > 0,
  };
  const score = CHECKS.reduce((s, c) => s + (ok[c.key] ? c.weight : 0), 0);
  return { score, missing: CHECKS.filter((c) => !ok[c.key]).map((c) => c.key) };
}

export const checkLabel = (key: string) => CHECKS.find((c) => c.key === key)?.label ?? key;
