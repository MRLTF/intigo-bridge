const crypto = require("crypto");
const axios = require("axios");

const {
  INTIGO_API_KEY,
  INTIGO_BASE_URL = "https://external-api.intigo.tn/secure-api",
  PICKUP_ADDRESS = "Moatmar Sup",
  PICKUP_CITY = "Sahline",
  PICKUP_SUBDIVISION = "Sahline",
  SHOPIFY_SHOP,                 // ex: theskiner.myshopify.com
  SHOPIFY_ADMIN_TOKEN,          // Admin API access token
  SHOPIFY_WEBHOOK_SECRET        // facultatif (recommandé)
} = process.env;

// cache en mémoire (vivant par instance lambda)
let REGIONS_CACHE = { ts: 0, data: null };

const clean = (s) =>
  (s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ").trim();

async function loadRegions() {
  const now = Date.now();
  if (REGIONS_CACHE.data && now - REGIONS_CACHE.ts < 24 * 3600 * 1000) {
    return REGIONS_CACHE.data;
  }
  const { data } = await axios.get(`${INTIGO_BASE_URL}/regions`, {
    headers: { Authorization: `{ apiKey: ${INTIGO_API_KEY} }` }
  });
  REGIONS_CACHE = { ts: now, data };
  return data; // attendu: [{ city: "Tunis", subDivisions: ["Le Bardo", ...] }, ...]
}

async function mapCitySubdivision(inputCity) {
  const regions = await loadRegions();
  const key = clean(inputCity);

  // match sur subdivision d'abord
  for (const r of regions) {
    for (const sd of (r.subDivisions || [])) {
      if (clean(sd) === key) return { city: r.city, subDivision: sd };
    }
  }
  // match sur ville
  for (const r of regions) {
    if (clean(r.city) === key) {
      const sd = (r.subDivisions && r.subDivisions[0]) || r.city;
      return { city: r.city, subDivision: sd };
    }
  }
  return null;
}

async function addOrderNote(orderId, noteText) {
  await axios.put(
    `https://${SHOPIFY_SHOP}/admin/api/2024-10/orders/${orderId}.json`,
    { order: { id: orderId, note: noteText } },
    {
      headers: {
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
        "Content-Type": "application/json"
      }
    }
  );
}

function verifyHmac(rawBody, header) {
  if (!SHOPIFY_WEBHOOK_SECRET) return true;
  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, "utf8")
    .digest("base64");
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(header || ""));
}

exports.handler = async (event) => {
  try {
    const rawBody = event.body || "";
    const okHmac = verifyHmac(rawBody, event.headers["x-shopify-hmac-sha256"]);
    if (!okHmac) return { statusCode: 401, body: "invalid hmac" };

    const order = JSON.parse(rawBody);

    // idempotence simple: si la note contient déjà NID, on ignore
    if ((order.note || "").includes("Intigo NID:")) {
      return { statusCode: 200, body: "already processed" };
    }

    const addr = order.shipping_address || {};
    const cityInput = addr.city || "";
    const phoneInput = (addr.phone || order.phone || "").replace(/\D/g, "").slice(-8);

    const mapped = await mapCitySubdivision(cityInput);
    if (!mapped || phoneInput.length !== 8) {
      await addOrderNote(order.id, `ADRESSE_A_VERIFIER | city="${cityInput}" | phone="${phoneInput}"`);
      return { statusCode: 200, body: "address to review" };
    }

    const payload = {
      cid: String(order.name || order.id),
      name: addr.name || `${order.customer?.first_name || ""} ${order.customer?.last_name || ""}`.trim(),
      phone: phoneInput,
      amount: Number(order.total_price) || 0,
      city: mapped.city,
      subDivision: mapped.subDivision,
      address: [addr.address1, addr.address2].filter(Boolean).join(" ").trim(),
      size: 1,
      isFragile: false,
      isExchange: false,
      description: `SKINER ${order.name}`,
      additionalInformation: "COD",
      pickUpAddress: PICKUP_ADDRESS,
      pickUpCity: PICKUP_CITY,
      pickUpSubDivision: PICKUP_SUBDIVISION
    };

    const { data } = await axios.post(`${INTIGO_BASE_URL}/parcels`, payload, {
      headers: {
        Authorization: `{ apiKey: ${INTIGO_API_KEY} }`,
        "Content-Type": "application/json"
      },
      validateStatus: s => s < 500
    });

    if (!data || !data.nid) {
      await addOrderNote(order.id, `INTIGO_ERREUR | mapped=${mapped.city}/${mapped.subDivision}`);
      return { statusCode: 200, body: "intigo error" };
    }

    await addOrderNote(
      order.id,
      `Intigo NID: ${data.nid}\nVille_norme: ${mapped.subDivision}\nGouvernorat_norme: ${mapped.city}`
    );

    return { statusCode: 200, body: "ok" };
  } catch (e) {
    console.error(e?.response?.data || e.message);
    return { statusCode: 500, body: "server error" };
  }
};
