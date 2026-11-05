import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { enqueue } from "../lib/queue.server";
import { factsOf } from "../lib/generate.server";
import { stripHtml } from "../lib/completeness";
import { validateGenerated, type GeneratedFields, type Warning } from "../lib/validate";
import { useAutoRefresh } from "../lib/useAutoRefresh";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;
  const [suggestions, drafting] = await Promise.all([
    db.suggestion.findMany({ where: { shopId, status: { in: ["pending", "failed"] } }, orderBy: { createdAt: "asc" }, take: 50 }),
    db.job.count({ where: { shopId, kind: "generate", status: { in: ["queued", "running"] } } }),
  ]);
  const products = await db.product.findMany({ where: { shopId, productGid: { in: suggestions.map((s) => s.productGid) } } });
  return {
    drafting,
    items: suggestions.map((s) => {
      const p = products.find((x) => x.productGid === s.productGid);
      return {
        id: s.id,
        status: s.status,
        error: s.error,
        title: p?.title ?? "Unknown product",
        score: p?.score ?? 0,
        old: p
          ? { descriptionHtml: p.descriptionHtml, seoTitle: p.seoTitle ?? "", seoDescription: p.seoDescription ?? "", images: p.images as { id: string; url: string; alt: string | null }[] }
          : null,
        fields: s.fields as unknown as GeneratedFields,
        warnings: s.warnings as unknown as Warning[],
        missingInfo: s.missingInfo,
      };
    }),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopId = session.shop;
  const reviewer = session.onlineAccessInfo?.associated_user?.email ?? session.shop; // who approved
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "reject") {
    await db.suggestion.updateMany({ where: { id: String(form.get("id")), shopId, status: "pending" }, data: { status: "rejected", reviewedBy: reviewer, reviewedAt: new Date() } });
    return { ok: true };
  }

  if (intent === "approve") {
    const s = await db.suggestion.findFirst({ where: { id: String(form.get("id")), shopId, status: "pending" } });
    if (!s) return { error: "This draft was already handled." };
    const p = await db.product.findUnique({ where: { shopId_productGid: { shopId, productGid: s.productGid } } });
    if (!p) return { error: "Product not found." };
    const settings = await db.shopSettings.findUnique({ where: { shopId } });
    const fields = JSON.parse(String(form.get("fields"))) as GeneratedFields;
    // Re-validate the merchant's edited version on the server.
    const warnings = validateGenerated(fields, factsOf(p), settings?.bannedWords ?? []);
    if (warnings.some((w) => w.blocking)) {
      await db.suggestion.update({ where: { id: s.id }, data: { fields: fields as object, warnings: warnings as object[] } });
      return { error: "Fix the highlighted problems before approving.", id: s.id };
    }
    await db.suggestion.update({ where: { id: s.id }, data: { fields: fields as object, warnings: warnings as object[], status: "approved", reviewedBy: reviewer, reviewedAt: new Date() } });
    await enqueue(shopId, "apply", [s.id]);
    return { ok: true, approved: 1 };
  }

  if (intent === "approve_ready") {
    const pending = await db.suggestion.findMany({ where: { shopId, status: "pending", id: { in: form.getAll("ids").map(String) } } });
    const ready = pending.filter((s) => !(s.warnings as unknown as Warning[]).some((w) => w.blocking));
    await db.suggestion.updateMany({ where: { id: { in: ready.map((s) => s.id) }, shopId }, data: { status: "approved", reviewedBy: reviewer, reviewedAt: new Date() } });
    await enqueue(shopId, "apply", ready.map((s) => s.id));
    return { ok: true, approved: ready.length };
  }
  return { error: "Unknown action" };
};

export default function Review() {
  const d = useLoaderData<typeof loader>();
  const bulk = useFetcher<typeof action>();
  useAutoRefresh(d.drafting > 0);
  const ready = d.items.filter((i) => i.status === "pending" && !i.warnings.some((w) => w.blocking));

  return (
    <s-page heading="Review drafts" inlineSize="large">
      {ready.length > 1 && (
        <s-button
          slot="primary-action"
          variant="primary"
          {...(bulk.state !== "idle" ? { loading: true } : {})}
          onClick={() => {
            const fd = new FormData();
            fd.set("intent", "approve_ready");
            ready.forEach((r) => fd.append("ids", r.id));
            bulk.submit(fd, { method: "POST" });
          }}
        >
          {`Approve ${ready.length} drafts without problems`}
        </s-button>
      )}

      {d.drafting > 0 && <s-banner tone="info">{`${d.drafting} draft(s) still being written. This page updates by itself.`}</s-banner>}
      {bulk.data && "approved" in bulk.data && <s-banner tone="success">{`${bulk.data.approved} draft(s) approved and queued for saving.`}</s-banner>}

      {d.items.length === 0 && d.drafting === 0 && (
        <s-section>
          <s-paragraph>No drafts to review. Go to Products, select items and choose “Write drafts”.</s-paragraph>
          <s-button href="/app/products">Go to Products</s-button>
        </s-section>
      )}

      {d.items.map((item) => (item.status === "failed" ? <FailedCard key={item.id} item={item} /> : <DraftCard key={item.id} item={item} />))}
    </s-page>
  );
}

type Item = ReturnType<typeof useLoaderData<typeof loader>>["items"][number];

function FailedCard({ item }: { item: Item }) {
  return (
    <s-section heading={item.title}>
      <s-banner tone="critical" heading="AI could not write a draft">
        <s-paragraph>{item.error}</s-paragraph>
        <s-paragraph>Nothing was filled in automatically. Try again from Products, or write the content yourself.</s-paragraph>
      </s-banner>
    </s-section>
  );
}

function DraftCard({ item }: { item: Item }) {
  const fetcher = useFetcher<typeof action>();
  const [f, setF] = useState<GeneratedFields>(item.fields);
  const errs = (field: string) => item.warnings.filter((w) => w.field === field && w.blocking).map((w) => w.message).join(" ");
  const busy = fetcher.state !== "idle";
  const send = (intent: string) => {
    const fd = new FormData();
    fd.set("intent", intent);
    fd.set("id", item.id);
    fd.set("fields", JSON.stringify(f));
    fetcher.submit(fd, { method: "POST" });
  };
  const altOf = (id: string) => f.imageAlts.find((a) => a.imageId === id)?.alt ?? "";

  return (
    <s-section heading={`${item.title} · ${item.score}% complete`}>
      <s-stack gap="base">
        {fetcher.data && "error" in fetcher.data && <s-banner tone="critical">{fetcher.data.error}</s-banner>}
        {item.warnings.filter((w) => !w.blocking).map((w, i) => <s-banner key={i} tone="warning">{w.message}</s-banner>)}
        {errs("general") && <s-banner tone="critical">{errs("general")}</s-banner>}
        {item.missingInfo.length > 0 && (
          <s-banner tone="info" heading="Information the AI did not have">
            <s-paragraph>{`Add these to your product to get better content: ${item.missingInfo.join(", ")}.`}</s-paragraph>
          </s-banner>
        )}

        <s-grid gridTemplateColumns="1fr 1fr" gap="base">
          <s-heading>Current</s-heading>
          <s-heading>New draft (you can edit)</s-heading>

          <s-box padding="small" background="subdued" borderRadius="base">
            <s-text>{stripHtml(item.old?.descriptionHtml ?? "") || "(empty)"}</s-text>
          </s-box>
          <s-text-area label="Description (HTML)" rows={8} value={f.descriptionHtml} error={errs("descriptionHtml") || undefined}
            onInput={(e) => setF({ ...f, descriptionHtml: (e.currentTarget as unknown as { value: string }).value })} />

          <s-text>{item.old?.seoTitle || "(empty)"}</s-text>
          <s-text-field label="SEO title" value={f.seoTitle} details={`${f.seoTitle.length}/70`} error={errs("seoTitle") || undefined}
            onInput={(e) => setF({ ...f, seoTitle: (e.currentTarget as unknown as { value: string }).value })} />

          <s-text>{item.old?.seoDescription || "(empty)"}</s-text>
          <s-text-area label="SEO description" rows={3} value={f.seoDescription} details={`${f.seoDescription.length}/160`} error={errs("seoDescription") || undefined}
            onInput={(e) => setF({ ...f, seoDescription: (e.currentTarget as unknown as { value: string }).value })} />
        </s-grid>

        {(item.old?.images.length ?? 0) > 0 && (
          <s-stack gap="small">
            <s-heading>Image alt text</s-heading>
            {errs("imageAlts") && <s-text tone="critical">{errs("imageAlts")}</s-text>}
            {item.old!.images.map((img) => (
              <s-stack key={img.id} direction="inline" gap="base" alignItems="center">
                <s-thumbnail src={img.url} alt={img.alt ?? ""} size="small" />
                <s-text color="subdued">{img.alt || "(no alt)"}</s-text>
                <s-text-field label="New alt text" labelAccessibilityVisibility="exclusive" value={altOf(img.id)}
                  onInput={(e) => {
                    const alt = (e.currentTarget as unknown as { value: string }).value;
                    setF({ ...f, imageAlts: [...f.imageAlts.filter((a) => a.imageId !== img.id), { imageId: img.id, alt }] });
                  }} />
              </s-stack>
            ))}
          </s-stack>
        )}

        <s-stack direction="inline" gap="small">
          <s-button variant="primary" {...(busy ? { loading: true } : {})} onClick={() => send("approve")}>Approve & save to store</s-button>
          <s-button tone="critical" disabled={busy} onClick={() => send("reject")}>Discard draft</s-button>
        </s-stack>
      </s-stack>
    </s-section>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
