import db from "../db.server";
import { scoreProduct } from "./completeness";

/** Minimal shape of the admin GraphQL client from authenticate.admin / unauthenticated.admin. */
export interface AdminClient {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
}

// All operations below were validated against Admin API 2026-10 with the Shopify AI Toolkit.

const BULK_PRODUCTS = `{
  products {
    edges {
      node {
        id title handle vendor productType tags descriptionHtml
        seo { title description }
        options { name optionValues { name } }
        media(first: 20) { edges { node { ... on MediaImage { id alt image { url } } } } }
      }
    }
  }
}`;

export async function gql<T>(admin: AdminClient, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await admin.graphql(query, { variables });
  const body = (await res.json()) as { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };
  if (body.errors?.length) {
    const throttled = body.errors.some((e) => e.extensions?.code === "THROTTLED");
    throw Object.assign(new Error(body.errors.map((e) => e.message).join("; ")), { throttled });
  }
  return body.data as T;
}

// ---------- 2.1 Scan with a bulk operation ----------
export async function startScan(admin: AdminClient, shopId: string) {
  const running = await db.scanJob.findFirst({ where: { shopId, status: { in: ["running", "ingesting"] } } });
  if (running) return running;
  const data = await gql<{ bulkOperationRunQuery: { bulkOperation: { id: string } | null; userErrors: { message: string }[] } }>(
    admin,
    `#graphql
    mutation StartScan($query: String!) {
      bulkOperationRunQuery(query: $query) { bulkOperation { id status } userErrors { field message } }
    }`,
    { query: BULK_PRODUCTS },
  );
  const r = data.bulkOperationRunQuery;
  if (!r.bulkOperation) {
    return db.scanJob.create({ data: { shopId, status: "failed", error: r.userErrors.map((e) => e.message).join("; "), finishedAt: new Date() } });
  }
  return db.scanJob.create({ data: { shopId, bulkOperationId: r.bulkOperation.id } });
}

/** Called from the home loader while a scan runs. Safe to call repeatedly (idempotent upserts). */
export async function refreshScan(admin: AdminClient, shopId: string) {
  const job = await db.scanJob.findFirst({ where: { shopId, status: "running" }, orderBy: { startedAt: "desc" } });
  if (!job?.bulkOperationId) return job;
  const data = await gql<{ node: { status: string; errorCode: string | null; objectCount: string; url: string | null } | null }>(
    admin,
    `#graphql
    query BulkStatus($id: ID!) { node(id: $id) { ... on BulkOperation { id status errorCode objectCount url } } }`,
    { id: job.bulkOperationId },
  );
  const op = data.node;
  if (!op) return job;
  if (op.status === "RUNNING" || op.status === "CREATED") {
    return db.scanJob.update({ where: { id: job.id }, data: { objectCount: Number(op.objectCount) } });
  }
  if (op.status !== "COMPLETED") {
    return db.scanJob.update({ where: { id: job.id }, data: { status: "failed", error: op.errorCode ?? op.status, finishedAt: new Date() } });
  }
  // Claim the job so two loaders do not ingest twice.
  const claimed = await db.scanJob.updateMany({ where: { id: job.id, status: "running" }, data: { status: "ingesting" } });
  if (claimed.count === 0) return job;
  try {
    const count = op.url ? await ingestJsonl(shopId, op.url) : 0;
    return db.scanJob.update({ where: { id: job.id }, data: { status: "completed", productCount: count, objectCount: Number(op.objectCount), finishedAt: new Date() } });
  } catch (err) {
    return db.scanJob.update({ where: { id: job.id }, data: { status: "failed", error: (err as Error).message, finishedAt: new Date() } });
  }
}

interface BulkProduct {
  id: string;
  title: string;
  handle: string;
  vendor: string;
  productType: string;
  tags: string[];
  descriptionHtml: string;
  seo: { title: string | null; description: string | null };
  options: { name: string; optionValues: { name: string }[] }[];
}

/** JSONL: products are lines; media lines carry __parentId. */
export async function ingestJsonl(shopId: string, url: string) {
  const text = await (await fetch(url)).text();
  const products = new Map<string, BulkProduct & { images: { id: string; url: string; alt: string | null }[] }>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (row.__parentId) {
      const parent = products.get(row.__parentId);
      if (parent && row.id?.includes("MediaImage")) parent.images.push({ id: row.id, url: row.image?.url ?? "", alt: row.alt ?? null });
    } else if (row.id?.includes("/Product/")) {
      products.set(row.id, { ...row, images: [] });
    }
  }
  const now = new Date();
  for (const p of products.values()) {
    const facts = {
      title: p.title,
      descriptionHtml: p.descriptionHtml ?? "",
      seoTitle: p.seo?.title,
      seoDescription: p.seo?.description,
      images: p.images,
      productType: p.productType,
      vendor: p.vendor,
      tags: p.tags,
    };
    const { score, missing } = scoreProduct(facts);
    const data = {
      title: p.title,
      handle: p.handle,
      vendor: p.vendor ?? "",
      productType: p.productType ?? "",
      tags: p.tags ?? [],
      options: p.options.map((o) => ({ name: o.name, values: o.optionValues.map((v) => v.name) })),
      descriptionHtml: p.descriptionHtml ?? "",
      seoTitle: p.seo?.title,
      seoDescription: p.seo?.description,
      images: p.images,
      score,
      missing,
      scannedAt: now,
    };
    await db.product.upsert({
      where: { shopId_productGid: { shopId, productGid: p.id } },
      create: { shopId, productGid: p.id, ...data },
      update: data,
    });
  }
  return products.size;
}

// ---------- 2.6 Writes ----------
export interface ContentState {
  descriptionHtml: string;
  seoTitle: string | null;
  seoDescription: string | null;
  imageAlts: { imageId: string; alt: string | null }[];
}

export async function writeProductContent(admin: AdminClient, productGid: string, c: ContentState) {
  const upd = await gql<{ productUpdate: { userErrors: { field: string[]; message: string }[] } }>(
    admin,
    `#graphql
    mutation UpdateProduct($product: ProductUpdateInput!) {
      productUpdate(product: $product) { product { id } userErrors { field message } }
    }`,
    { product: { id: productGid, descriptionHtml: c.descriptionHtml, seo: { title: c.seoTitle ?? "", description: c.seoDescription ?? "" } } },
  );
  if (upd.productUpdate.userErrors.length) throw new Error(upd.productUpdate.userErrors.map((e) => e.message).join("; "));

  if (c.imageAlts.length) {
    const files = await gql<{ fileUpdate: { userErrors: { message: string }[] } }>(
      admin,
      `#graphql
      mutation UpdateAlt($files: [FileUpdateInput!]!) {
        fileUpdate(files: $files) { files { id alt } userErrors { field message code } }
      }`,
      { files: c.imageAlts.map((a) => ({ id: a.imageId, alt: a.alt ?? "" })) },
    );
    if (files.fileUpdate.userErrors.length) throw new Error(files.fileUpdate.userErrors.map((e) => e.message).join("; "));
  }
}
