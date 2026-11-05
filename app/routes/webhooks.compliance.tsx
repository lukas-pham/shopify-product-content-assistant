import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * Mandatory privacy webhooks. authenticate.webhook verifies the HMAC.
 * This app stores no customer data, so customer requests have nothing to return or delete.
 * shop/redact (48h after uninstall) removes everything stored for the shop.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);
  if (topic === "SHOP_REDACT") {
    await db.$transaction([
      db.job.deleteMany({ where: { shopId: shop } }),
      db.suggestion.deleteMany({ where: { shopId: shop } }),
      db.productVersion.deleteMany({ where: { shopId: shop } }),
      db.product.deleteMany({ where: { shopId: shop } }),
      db.scanJob.deleteMany({ where: { shopId: shop } }),
      db.aiCall.deleteMany({ where: { shopId: shop } }),
      db.shopSettings.deleteMany({ where: { shopId: shop } }),
      db.session.deleteMany({ where: { shop } }),
    ]);
  }
  return new Response();
};
