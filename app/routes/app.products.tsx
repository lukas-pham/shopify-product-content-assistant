import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { enqueue } from "../lib/queue.server";
import { checkLabel } from "../lib/completeness";

const PAGE = 50;
const MAX_BATCH = 1000;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const filter = url.searchParams.get("filter") ?? "incomplete";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
  const where = { shopId: session.shop, ...(filter === "incomplete" ? { score: { lt: 100 } } : {}) };
  const [products, total, drafting] = await Promise.all([
    db.product.findMany({ where, orderBy: [{ score: "asc" }, { title: "asc" }], skip: (page - 1) * PAGE, take: PAGE }),
    db.product.count({ where }),
    db.job.findMany({ where: { shopId: session.shop, kind: "generate", status: { in: ["queued", "running"] } }, select: { refId: true } }),
  ]);
  const busy = new Set(drafting.map((j) => j.refId));
  return {
    filter,
    page,
    pages: Math.max(1, Math.ceil(total / PAGE)),
    total,
    products: products.map((p) => ({ gid: p.productGid, title: p.title, score: p.score, missing: p.missing, drafting: busy.has(p.productGid) })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  let ids = form.getAll("ids").map(String);
  if (form.get("all") === "1") {
    ids = (await db.product.findMany({ where: { shopId: session.shop, score: { lt: 100 } }, select: { productGid: true }, take: MAX_BATCH })).map((p) => p.productGid);
  }
  // Only products of this shop can be queued.
  const owned = await db.product.findMany({ where: { shopId: session.shop, productGid: { in: ids } }, select: { productGid: true } });
  if (!owned.length) return { error: "Select at least one product." };
  await enqueue(session.shop, "generate", owned.map((p) => p.productGid), `batch-${Date.now()}`);
  return { queued: owned.length };
};

export default function Products() {
  const d = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [params, setParams] = useSearchParams();
  const [selected, setSelected] = useState<string[]>([]);
  const toggle = (gid: string, on: boolean) => setSelected((s) => (on ? [...s, gid] : s.filter((x) => x !== gid)));
  const submit = (data: { ids?: string[]; all?: boolean }) => {
    const fd = new FormData();
    (data.ids ?? []).forEach((id) => fd.append("ids", id));
    if (data.all) fd.set("all", "1");
    fetcher.submit(fd, { method: "POST" });
    setSelected([]);
  };
  const busy = fetcher.state !== "idle";

  return (
    <s-page heading="Products" inlineSize="large">
      <s-button slot="primary-action" variant="primary" disabled={!selected.length || busy} onClick={() => submit({ ids: selected })}>
        {`Write drafts for ${selected.length} selected`}
      </s-button>
      <s-button slot="secondary-actions" disabled={busy} onClick={() => submit({ all: true })}>
        Write drafts for all incomplete
      </s-button>

      {fetcher.data && "queued" in fetcher.data && (
        <s-banner tone="success" heading={`${fetcher.data.queued} product(s) queued`}>
          <s-paragraph>Drafts appear in Review drafts as they are ready. Nothing is saved to your store until you approve.</s-paragraph>
        </s-banner>
      )}
      {fetcher.data && "error" in fetcher.data && <s-banner tone="critical">{fetcher.data.error}</s-banner>}

      <s-section padding="none">
        <s-stack direction="inline" gap="small" padding="base">
          <s-button variant={d.filter === "incomplete" ? "primary" : "secondary"} onClick={() => setParams({ filter: "incomplete" })}>Incomplete</s-button>
          <s-button variant={d.filter === "all" ? "primary" : "secondary"} onClick={() => setParams({ filter: "all" })}>All</s-button>
          <s-text color="subdued">{d.total} products</s-text>
        </s-stack>
        {d.products.length === 0 ? (
          <s-box padding="base">
            <s-paragraph>No products here. Run a scan from Home, or switch to “All”.</s-paragraph>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Select</s-table-header>
              <s-table-header listSlot="primary">Product</s-table-header>
              <s-table-header format="numeric">Completeness</s-table-header>
              <s-table-header>Missing</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {d.products.map((p) => (
                <s-table-row key={p.gid}>
                  <s-table-cell>
                    <s-checkbox
                      accessibilityLabel={`Select ${p.title}`}
                      checked={selected.includes(p.gid)}
                      disabled={p.drafting}
                      onChange={(e) => toggle(p.gid, (e.currentTarget as unknown as { checked: boolean }).checked)}
                    />
                  </s-table-cell>
                  <s-table-cell>
                    {p.title} {p.drafting && <s-badge tone="info">Drafting…</s-badge>}
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={p.score >= 80 ? "success" : p.score >= 50 ? "caution" : "critical"}>{`${p.score}%`}</s-badge>
                  </s-table-cell>
                  <s-table-cell>{p.missing.map(checkLabel).join(", ") || "—"}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
        <s-stack direction="inline" gap="small" padding="base">
          <s-button disabled={d.page <= 1} onClick={() => setParams({ filter: d.filter, page: String(d.page - 1) })}>Previous</s-button>
          <s-text>{`Page ${d.page} of ${d.pages}`}</s-text>
          <s-button disabled={d.page >= d.pages} onClick={() => setParams({ filter: d.filter, page: String(d.page + 1) })}>Next</s-button>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
