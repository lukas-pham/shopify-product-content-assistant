import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { enqueue } from "../lib/queue.server";
import { useAutoRefresh } from "../lib/useAutoRefresh";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;
  const [versions, failed, reverting] = await Promise.all([
    db.productVersion.findMany({ where: { shopId }, orderBy: { createdAt: "desc" }, take: 100 }),
    db.suggestion.findMany({ where: { shopId, status: "failed", reviewedBy: { not: null } }, orderBy: { createdAt: "desc" }, take: 20 }),
    db.job.findMany({ where: { shopId, kind: "revert", status: { in: ["queued", "running"] } }, select: { refId: true } }),
  ]);
  const products = await db.product.findMany({ where: { shopId, productGid: { in: [...versions, ...failed].map((v) => v.productGid) } }, select: { productGid: true, title: true } });
  const title = (gid: string) => products.find((p) => p.productGid === gid)?.title ?? gid;
  return {
    versions: versions.map((v) => ({ id: v.id, title: title(v.productGid), at: v.createdAt, revertedAt: v.revertedAt, reverting: reverting.some((r) => r.refId === v.id) })),
    failed: failed.map((s) => ({ id: s.id, title: title(s.productGid), error: s.error })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const id = String((await request.formData()).get("id"));
  const v = await db.productVersion.findFirst({ where: { id, shopId: session.shop, revertedAt: null } });
  if (!v) return { error: "This change was already undone." };
  await enqueue(session.shop, "revert", [v.id]);
  return { ok: true };
};

export default function History() {
  const d = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  useAutoRefresh(d.versions.some((v) => v.reverting));
  return (
    <s-page heading="History & undo">
      {d.failed.length > 0 && (
        <s-banner tone="critical" heading="Some approved drafts could not be saved">
          <s-unordered-list>
            {d.failed.map((f) => <s-list-item key={f.id}>{`${f.title}: ${f.error}`}</s-list-item>)}
          </s-unordered-list>
        </s-banner>
      )}
      {fetcher.data && "error" in fetcher.data && <s-banner tone="critical">{fetcher.data.error}</s-banner>}
      <s-section padding="none">
        {d.versions.length === 0 ? (
          <s-box padding="base"><s-paragraph>No changes saved yet.</s-paragraph></s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Product</s-table-header>
              <s-table-header>Saved</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Action</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {d.versions.map((v) => (
                <s-table-row key={v.id}>
                  <s-table-cell>{v.title}</s-table-cell>
                  <s-table-cell>{new Date(v.at).toLocaleString()}</s-table-cell>
                  <s-table-cell>
                    {v.revertedAt ? <s-badge>Undone</s-badge> : v.reverting ? <s-badge tone="info">Undoing…</s-badge> : <s-badge tone="success">Live</s-badge>}
                  </s-table-cell>
                  <s-table-cell>
                    {!v.revertedAt && !v.reverting && (
                      <s-button onClick={() => fetcher.submit({ id: v.id }, { method: "POST" })}>Undo — restore previous content</s-button>
                    )}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
