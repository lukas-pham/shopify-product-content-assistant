import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const s = await db.shopSettings.upsert({ where: { shopId: session.shop }, create: { shopId: session.shop }, update: {} });
  return { voice: s.voice, audience: s.audience, bannedWords: s.bannedWords.join(", "), language: s.language };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const voice = String(form.get("voice") ?? "").trim();
  const audience = String(form.get("audience") ?? "").trim();
  const language = String(form.get("language") ?? "en");
  const bannedWords = String(form.get("bannedWords") ?? "").split(",").map((w) => w.trim()).filter(Boolean);
  const errors: Record<string, string> = {};
  if (voice.length < 10) errors.voice = "Describe the voice in at least 10 characters, e.g. “Warm, playful, no jargon”.";
  if (voice.length > 500) errors.voice = "Keep it under 500 characters.";
  if (bannedWords.length > 50) errors.bannedWords = "Up to 50 words.";
  if (Object.keys(errors).length) return { errors };
  await db.shopSettings.upsert({
    where: { shopId: session.shop },
    create: { shopId: session.shop, voice, audience, bannedWords, language },
    update: { voice, audience, bannedWords, language },
  });
  return { saved: true };
};

export default function Settings() {
  const d = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const errors: Record<string, string | undefined> = result && "errors" in result ? (result.errors ?? {}) : {};
  const saving = useNavigation().state === "submitting";
  return (
    <s-page heading="Brand voice">
      {/* data-save-bar shows the Contextual Save Bar while the form is dirty (BFS 4.1.5) */}
      <Form method="post" data-save-bar data-discard-confirmation>
        <s-section heading="How drafts should sound">
          <s-stack gap="base">
            {result && "saved" in result && !saving && <s-banner tone="success">Saved. New drafts use this voice.</s-banner>}
            <s-text-area name="voice" label="Voice" rows={3} defaultValue={d.voice} error={errors.voice}
              details="Example: Warm and confident. Short sentences. Explain benefits plainly." />
            <s-text-field name="audience" label="Who buys from you" defaultValue={d.audience} details="Example: Busy parents shopping for durable kids' clothes." />
            <s-select name="language" label="Language" value={d.language}>
              <s-option value="en">English</s-option>
              <s-option value="vi">Vietnamese</s-option>
              <s-option value="fr">French</s-option>
              <s-option value="de">German</s-option>
            </s-select>
            <s-text-field name="bannedWords" label="Words never to use" defaultValue={d.bannedWords} error={errors.bannedWords}
              details="Comma separated, e.g. cheap, best ever" />
          </s-stack>
        </s-section>
      </Form>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
