import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { refreshScan, startScan } from "../lib/shopify-ops.server";
import { dailyCap, isMockMode, spentToday } from "../lib/ai.server";
import { useAutoRefresh } from "../lib/useAutoRefresh";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shopId = session.shop;
  let scanError: string | null = null;
  try {
    await refreshScan(admin, shopId);
  } catch (err) {
    scanError = (err as Error).message;
  }

  const [total, complete, avg, pending, applied, lastScan, jobs] = await Promise.all([
    db.product.count({ where: { shopId } }),
    db.product.count({ where: { shopId, score: 100 } }),
    db.product.aggregate({ where: { shopId }, _avg: { score: true } }),
    db.suggestion.count({ where: { shopId, status: "pending" } }),
    db.suggestion.count({ where: { shopId, status: "applied" } }),
    db.scanJob.findFirst({ where: { shopId }, orderBy: { startedAt: "desc" } }),
    db.job.groupBy({ by: ["kind", "status"], where: { shopId, createdAt: { gte: new Date(Date.now() - 86_400_000) } }, _count: true }),
  ]);
  const count = (kind: string, status: string) => jobs.find((j) => j.kind === kind && j.status === status)?._count ?? 0;

  return {
    total,
    complete,
    avgScore: Math.round(avg._avg.score ?? 0),
    pending,
    applied,
    lastScan,
    scanError,
    progress: ["generate", "apply", "revert"].map((k) => ({
      kind: k,
      queued: count(k, "queued") + count(k, "running"),
      done: count(k, "done"),
      failed: count(k, "failed"),
    })),
    ai: { mock: isMockMode(), spent: await spentToday(shopId), cap: dailyCap() },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const job = await startScan(admin, session.shop);
  return { job };
};

const LABEL: Record<string, string> = { generate: "Writing drafts", apply: "Saving to store", revert: "Undoing" };

export default function Home() {
  const d = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const scanning = d.lastScan?.status === "running" || d.lastScan?.status === "ingesting";
  const busy = d.progress.some((p) => p.queued > 0);
  useAutoRefresh(scanning || busy);

  const neverScanned = !d.lastScan;
  const startScanBtn = (
    <s-button
      variant="primary"
      onClick={() => fetcher.submit({}, { method: "POST" })}
      {...(fetcher.state !== "idle" || scanning ? { loading: true } : {})}
    >
      {neverScanned ? "Scan my catalog" : "Scan again"}
    </s-button>
  );

  return (
    <s-page heading="Product content">
      <s-button slot="primary-action" href="/app/products">Find products to improve</s-button>

      {/* Is the app working? (BFS 4.2.3) */}
      {neverScanned ? (
        <s-banner tone="info" heading="Start with a catalog scan">
          <s-paragraph>The app reads your products and scores how complete each one is. Nothing in your store changes until you approve a draft.</s-paragraph>
          {startScanBtn}
        </s-banner>
      ) : d.lastScan?.status === "failed" || d.scanError ? (
        <s-banner tone="critical" heading="The last scan did not finish">
          <s-paragraph>{d.lastScan?.error || d.scanError}</s-paragraph>
          {startScanBtn}
        </s-banner>
      ) : scanning ? (
        <s-banner tone="info" heading="Scanning your catalog…">
          <s-paragraph>{d.lastScan?.objectCount ?? 0} items read so far. You can leave this page; progress is saved.</s-paragraph>
        </s-banner>
      ) : (
        <s-banner tone="success" heading="App is working">
          <s-paragraph>
            Last scan {new Date(d.lastScan!.finishedAt ?? d.lastScan!.startedAt).toLocaleString()} · {d.lastScan!.productCount} products.
          </s-paragraph>
        </s-banner>
      )}

      <s-section heading="Catalog at a glance">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap="base">
          <Metric label="Average completeness" value={`${d.avgScore}%`} />
          <Metric label="Fully complete products" value={`${d.complete} / ${d.total}`} />
          <Metric label="Drafts waiting for you" value={String(d.pending)} href="/app/review" />
          <Metric label="Products updated" value={String(d.applied)} href="/app/history" />
        </s-grid>
      </s-section>

      {busy && (
        <s-section heading="In progress">
          <s-stack gap="small-200">
            {d.progress.filter((p) => p.queued + p.done + p.failed > 0).map((p) => (
              <s-text key={p.kind}>
                {LABEL[p.kind]}: {p.done} done · {p.queued} waiting{p.failed ? ` · ${p.failed} failed` : ""}
              </s-text>
            ))}
          </s-stack>
        </s-section>
      )}

      <s-section heading="How it works" slot="aside">
        <s-ordered-list>
          <s-list-item>Scan scores each product: description, SEO title and description, image alt text.</s-list-item>
          <s-list-item>Pick products and let AI draft content from the data you already have.</s-list-item>
          <s-list-item>Compare old and new, edit, and approve. Only approved drafts are saved.</s-list-item>
          <s-list-item>Every change can be undone from History.</s-list-item>
        </s-ordered-list>
      </s-section>

      <s-section heading="AI usage today" slot="aside">
        {d.ai.mock ? (
          <s-badge tone="caution">Demo mode — no AI key configured</s-badge>
        ) : (
          <s-text>
            ${d.ai.spent.toFixed(2)} of ${d.ai.cap.toFixed(2)} daily limit
          </s-text>
        )}
      </s-section>
    </s-page>
  );
}

function Metric({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack gap="small-200">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{value}</s-heading>
        {href && <s-link href={href}>View</s-link>}
      </s-stack>
    </s-box>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
