import { stripHtml, wordCount, type ProductFacts } from "./completeness";

/**
 * Deterministic checks on AI output, run BEFORE the merchant sees it (req 2.3, 2.4, BFS 4.3.1).
 * Blocking warnings disable approval until the merchant edits the field.
 */

export interface GeneratedFields {
  descriptionHtml: string;
  seoTitle: string;
  seoDescription: string;
  imageAlts: { imageId: string; alt: string }[];
}

export interface Warning {
  field: keyof GeneratedFields | "general";
  code: "too_long" | "too_short" | "html" | "unsupported_fact" | "promise" | "banned_word" | "unknown_image";
  message: string;
  blocking: boolean;
}

export const LIMITS = { seoTitle: 70, seoDescription: 160, alt: 125, descriptionMinWords: 40, descriptionMaxWords: 400 };

const ALLOWED_TAGS = new Set(["p", "ul", "ol", "li", "strong", "em", "br", "h3"]);

// Revenue / ranking promises are not allowed in the UI or generated copy (BFS 4.3.1).
const PROMISE = /\b(boost (your )?sales|increase (your )?(sales|revenue|conversions?)|guarantee[ds]?|rank(ing)? (#?1|first|higher)|top of google|more traffic)\b/i;

/** Numbers + units are the most common hallucinated "specs". */
const SPEC_TOKEN = /(\d+(?:[.,]\d+)?)\s*(%|mm|cm|m|km|in|inch(?:es)?|ft|g|kg|lb|lbs|oz|ml|l|w|kw|v|mah|gb|tb|hz|°c|°f|hours?|hrs?|years?|months?|days?)?\b/gi;

export function sourceText(p: ProductFacts & { options?: unknown }) {
  return [p.title, stripHtml(p.descriptionHtml), p.vendor, p.productType, (p.tags ?? []).join(" "), JSON.stringify(p.options ?? [])]
    .join(" ")
    .toLowerCase();
}

/** Returns spec-like tokens in `text` that do not appear anywhere in the product data. */
export function unsupportedFacts(text: string, source: string): string[] {
  const src = source.replace(/,/g, ".");
  const found = new Set<string>();
  for (const m of stripHtml(text).matchAll(SPEC_TOKEN)) {
    const num = m[1].replace(",", ".");
    if (!src.includes(num)) found.add(m[0].trim());
  }
  return [...found];
}

export function validateGenerated(
  out: GeneratedFields,
  product: ProductFacts & { options?: unknown },
  bannedWords: string[] = [],
): Warning[] {
  const w: Warning[] = [];
  const src = sourceText(product);

  // Lengths
  if (out.seoTitle.length > LIMITS.seoTitle)
    w.push({ field: "seoTitle", code: "too_long", message: `SEO title is ${out.seoTitle.length} characters (max ${LIMITS.seoTitle}).`, blocking: true });
  if (!out.seoTitle.trim()) w.push({ field: "seoTitle", code: "too_short", message: "SEO title is empty.", blocking: true });
  if (out.seoDescription.length > LIMITS.seoDescription)
    w.push({ field: "seoDescription", code: "too_long", message: `SEO description is ${out.seoDescription.length} characters (max ${LIMITS.seoDescription}).`, blocking: true });
  const words = wordCount(stripHtml(out.descriptionHtml));
  if (words < LIMITS.descriptionMinWords)
    w.push({ field: "descriptionHtml", code: "too_short", message: `Description has ${words} words (min ${LIMITS.descriptionMinWords}). There may not be enough product data.`, blocking: false });
  if (words > LIMITS.descriptionMaxWords)
    w.push({ field: "descriptionHtml", code: "too_long", message: `Description has ${words} words (max ${LIMITS.descriptionMaxWords}).`, blocking: true });

  // HTML format
  const tags = [...out.descriptionHtml.matchAll(/<\/?([a-z0-9]+)[^>]*>/gi)].map((m) => m[1].toLowerCase());
  const bad = [...new Set(tags.filter((t) => !ALLOWED_TAGS.has(t)))];
  if (bad.length) w.push({ field: "descriptionHtml", code: "html", message: `Disallowed HTML tags: ${bad.join(", ")}.`, blocking: true });
  if (/\s(on\w+|style)=/i.test(out.descriptionHtml)) w.push({ field: "descriptionHtml", code: "html", message: "HTML attributes (style/on*) are not allowed.", blocking: true });

  // Alt text
  const imageIds = new Set(product.images.map((i) => i.id));
  for (const a of out.imageAlts) {
    if (!imageIds.has(a.imageId)) w.push({ field: "imageAlts", code: "unknown_image", message: `Alt text refers to an unknown image.`, blocking: true });
    if (a.alt.length > LIMITS.alt) w.push({ field: "imageAlts", code: "too_long", message: `An alt text is ${a.alt.length} characters (max ${LIMITS.alt}).`, blocking: true });
  }

  // Invented specs (req 2.4)
  for (const field of ["descriptionHtml", "seoTitle", "seoDescription"] as const) {
    const extra = unsupportedFacts(out[field], src);
    if (extra.length)
      w.push({ field, code: "unsupported_fact", message: `Contains facts not found in the product data: ${extra.join(", ")}. Edit or remove before approving.`, blocking: true });
  }

  // Promises + banned words
  const all = [out.descriptionHtml, out.seoTitle, out.seoDescription].join(" ");
  if (PROMISE.test(all)) w.push({ field: "general", code: "promise", message: "Copy promises sales or ranking results. Remove that claim.", blocking: true });
  for (const word of bannedWords.filter(Boolean)) {
    if (all.toLowerCase().includes(word.toLowerCase()))
      w.push({ field: "general", code: "banned_word", message: `Uses a banned word: "${word}".`, blocking: true });
  }
  return w;
}

/** Keeps only allowed tags and strips attributes — applied before writing to Shopify. */
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<\s*(script|style|iframe)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\/?([a-z0-9]+)([^>]*)>/gi, (m, tag: string) => {
      const t = tag.toLowerCase();
      if (!ALLOWED_TAGS.has(t)) return "";
      return m.startsWith("</") ? `</${t}>` : t === "br" ? "<br>" : `<${t}>`;
    });
}
