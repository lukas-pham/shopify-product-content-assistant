import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { AiError } from "./ai.server";
import { generateForProduct } from "./generate.server";
import { gql, writeProductContent, type AdminClient, type ContentState } from "./shopify-ops.server";
import { sanitizeHtml } from "./validate";
import { scoreProduct } from "./completeness";

/**
 * Durable DB queue (table `jobs`). Progress survives reloads/restarts because the UI reads job rows.
 * - generate: AI draft -> Suggestion(pending). Never writes to the store.
 * - apply:    only for suggestions a merchant approved. Saves the live "before" state first (undo).
 * - revert:   writes a saved "before" state back.
 * Retries with exponential backoff; throttling waits longer and does not burn attempts as fast.
 */

const MAX_ATTEMPTS = 5;
const CONCURRENCY = 2;
let started = false;

export async function enqueue(shopId: string, kind: "generate" | "apply" | "revert", refIds: string[], batchId?: string) {
  if (!refIds.length) return;
  await db.job.createMany({ data: refIds.map((refId) => ({ shopId, kind, refId, batchId })) });
}

export function startWorker() {
  if (started || process.env.DISABLE_WORKER) return;
  started = true;
  // Jobs left "running" by a crash are retried.
  void db.job.updateMany({ where: { status: "running" }, data: { status: "queued" } });
  const tick = async () => {
    try {
      const jobs = await db.job.findMany({ where: { status: "queued", nextRunAt: { lte: new Date() } }, orderBy: { createdAt: "asc" }, take: CONCURRENCY });
      await Promise.all(jobs.map(runJob));
    } catch (err) {
      console.error("[queue] tick failed", err);
    } finally {
      setTimeout(tick, 1000);
    }
  };
  void tick();
}

async function runJob(job: { id: string; shopId: string; kind: string; refId: string; attempts: number }) {
  const claimed = await db.job.updateMany({ where: { id: job.id, status: "queued" }, data: { status: "running", attempts: { increment: 1 } } });
  if (!claimed.count) return;
  try {
    if (job.kind === "generate") await runGenerate(job.shopId, job.refId);
    else {
      const { admin } = await unauthenticated.admin(job.shopId);
      if (job.kind === "apply") await runApply(admin, job.shopId, job.refId);
      else await runRevert(admin, job.shopId, job.refId);
    }
    await db.job.update({ where: { id: job.id }, data: { status: "done", lastError: null } });
  } catch (err) {
    const e = err as Error & { throttled?: boolean };
    const attempts = job.attempts + 1;
    const permanent = err instanceof AiError && (err.kind === "budget" || err.kind === "refusal");
    const giveUp = permanent || attempts >= MAX_ATTEMPTS;
    const delayMs = (e.throttled ? 10_000 : 2_000) * 2 ** (attempts - 1);
    await db.job.update({
      where: { id: job.id },
      data: giveUp
        ? { status: "failed", lastError: e.message }
        : { status: "queued", lastError: e.message, nextRunAt: new Date(Date.now() + delayMs), ...(e.throttled ? { attempts: { decrement: 1 } } : {}) },
    });
    if (giveUp) await onFinalFailure(job, e.message);
  }
}

async function onFinalFailure(job: { shopId: string; kind: string; refId: string }, message: string) {
  if (job.kind === "apply") await db.suggestion.updateMany({ where: { id: job.refId, shopId: job.shopId }, data: { status: "failed", error: message } });
  if (job.kind === "generate") {
    // Show the failure to the merchant instead of inventing content.
    await db.suggestion.create({
      data: { shopId: job.shopId, productGid: job.refId, status: "failed", fields: {}, promptVersion: "-", error: message },
    });
  }
}

async function runGenerate(shopId: string, productGid: string) {
  const product = await db.product.findUnique({ where: { shopId_productGid: { shopId, productGid } } });
  if (!product) throw new Error("Product not found. Run a new scan.");
  const settings = await db.shopSettings.upsert({ where: { shopId }, create: { shopId }, update: {} });
  const { fields, missingInfo, warnings } = await generateForProduct(product, settings);
  // Replace an older pending draft for the same product.
  await db.suggestion.deleteMany({ where: { shopId, productGid, status: { in: ["pending", "failed"] } } });
  await db.suggestion.create({
    data: { shopId, productGid, fields: fields as object, missingInfo, warnings: warnings as object[], promptVersion: "enrich-v0.1" },
  });
}

async function readLiveContent(admin: AdminClient, productGid: string): Promise<ContentState> {
  const d = await gql<{ product: { descriptionHtml: string; seo: { title: string | null; description: string | null }; media: { nodes: { id?: string; alt?: string | null }[] } } | null }>(
    admin,
    `#graphql
    query LiveContent($id: ID!) {
      product(id: $id) { id descriptionHtml seo { title description } media(first: 20) { nodes { ... on MediaImage { id alt } } } }
    }`,
    { id: productGid },
  );
  if (!d.product) throw new Error("Product no longer exists in the store.");
  return {
    descriptionHtml: d.product.descriptionHtml,
    seoTitle: d.product.seo.title,
    seoDescription: d.product.seo.description,
    imageAlts: d.product.media.nodes.filter((n) => n.id).map((n) => ({ imageId: n.id!, alt: n.alt ?? null })),
  };
}

async function runApply(admin: AdminClient, shopId: string, suggestionId: string) {
  const s = await db.suggestion.findFirst({ where: { id: suggestionId, shopId } });
  // Hard gate: nothing is written without a merchant approval.
  if (!s || s.status !== "approved" || !s.reviewedBy) throw Object.assign(new Error("Suggestion is not approved"), { throttled: false });
  const f = s.fields as unknown as ContentState;
  const before = await readLiveContent(admin, s.productGid);
  const after: ContentState = {
    descriptionHtml: sanitizeHtml(f.descriptionHtml),
    seoTitle: f.seoTitle,
    seoDescription: f.seoDescription,
    imageAlts: f.imageAlts.filter((a) => before.imageAlts.some((b) => b.imageId === a.imageId)),
  };
  const version = await db.productVersion.create({ data: { shopId, productGid: s.productGid, suggestionId, before: before as object, after: after as object } });
  try {
    await writeProductContent(admin, s.productGid, after);
  } catch (err) {
    await db.productVersion.delete({ where: { id: version.id } });
    throw err;
  }
  await db.suggestion.update({ where: { id: s.id }, data: { status: "applied" } });
  await refreshLocalProduct(shopId, s.productGid, after);
}

async function runRevert(admin: AdminClient, shopId: string, versionId: string) {
  const v = await db.productVersion.findFirst({ where: { id: versionId, shopId } });
  if (!v || v.revertedAt) return;
  const before = v.before as unknown as ContentState;
  await writeProductContent(admin, v.productGid, before);
  await db.productVersion.update({ where: { id: v.id }, data: { revertedAt: new Date() } });
  await db.suggestion.updateMany({ where: { id: v.suggestionId, shopId }, data: { status: "reverted" } });
  await refreshLocalProduct(shopId, v.productGid, before);
}

async function refreshLocalProduct(shopId: string, productGid: string, c: ContentState) {
  const p = await db.product.findUnique({ where: { shopId_productGid: { shopId, productGid } } });
  if (!p) return;
  const images = (p.images as { id: string; url: string; alt: string | null }[]).map((img) => ({
    ...img,
    alt: c.imageAlts.find((a) => a.imageId === img.id)?.alt ?? img.alt,
  }));
  const next = { descriptionHtml: c.descriptionHtml, seoTitle: c.seoTitle, seoDescription: c.seoDescription, images };
  const { score, missing } = scoreProduct({ ...p, ...next });
  await db.product.update({ where: { id: p.id }, data: { ...next, score, missing } });
}
