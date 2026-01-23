import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { Resend } from "resend";

dotenv.config();

const app = express();

// Чтобы Comgate callback (POST) читался нормально:
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// На тесте можно "*", потом сделаем строго.
app.use(cors({ origin: "*" }));

app.get("/health", (req, res) => res.json({ ok: true }));

// ✅ НУЖНОЕ: временное хранилище заказов (MVP)
const orders = new Map();

// ✅ НУЖНОЕ: чтобы находить заказ по transId, если refId не пришёл
const transIdToRefId = new Map();

// ✅ НУЖНОЕ: отправка писем через RESEND (HTTPS) — без SMTP таймаутов на Render
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

async function sendMail({ to, subject, html }) {
  if (!resend) {
    console.log("[MAIL] RESEND_API_KEY missing -> skip sending");
    return;
  }

  // ✅ from можно переопределить через ENV
  const from = process.env.MAIL_FROM || "onboarding@resend.dev";

  try {
    const r = await resend.emails.send({ from, to, subject, html });
    console.log(`[MAIL] sent -> ${to} | ${subject} | id: ${r?.data?.id || "—"}`);
  } catch (e) {
    console.log("[MAIL] send error:", e?.message || e);
  }
}

function formatCzk(n) {
  const num = Number(n || 0);
  try {
    return num.toLocaleString("cs-CZ", { style: "currency", currency: "CZK" });
  } catch {
    return `${num} CZK`;
  }
}

function shippingToHuman(shipping) {
  switch (shipping) {
    case "cz_pickup": return "CZ — Z-Point/Z-Box (Pickup)";
    case "cz_home":   return "CZ — Domů (Delivery)";
    case "sk_pickup": return "SK — Z-Point/Z-Box (Pickup)";
    case "sk_home":   return "SK — Domů (Delivery)";
    default:          return shipping || "—";
  }
}

function deliveryInfoHtml(order) {
  if (order.packeta?.pointId) {
    const name = order.packeta?.name || "";
    const addr = order.packeta?.address || "";
    return `
      <h3>Pickup point (Zásilkovna)</h3>
      <p><b>ID:</b> ${order.packeta.pointId}</p>
      ${name ? `<p><b>Name:</b> ${name}</p>` : ""}
      ${addr ? `<p><b>Address:</b> ${addr}</p>` : ""}
    `;
  }

  if (order.address?.street) {
    return `
      <h3>Delivery address</h3>
      <p>
        ${order.address.street}<br/>
        ${order.address.city} ${order.address.zip}<br/>
        ${order.address.country}
      </p>
    `;
  }

  return `<h3>Delivery info</h3><p>—</p>`;
}

function itemsToHtml(items = []) {
  if (!Array.isArray(items) || items.length === 0) return "<i>Items not provided</i>";

  const rows = items
    .map((i) => {
      const name = i?.name || "Produkt";
      const variant = i?.variant ? ` (${i.variant})` : "";
      const qty = Number(i?.qty || 1);
      const line = Number(i?.lineTotalCzk || 0);
      const price = line > 0 ? ` — <b>${formatCzk(line)}</b>` : "";
      return `<li>${name}${variant} — qty: <b>${qty}</b>${price}</li>`;
    })
    .join("");

  return `<ul>${rows}</ul>`;
}

async function comgateCreatePayment({
  merchant,
  secret,
  test,
  price,
  curr,
  label,
  refId,
  method,
  email,
  phone,
  fullName,
  delivery,
  category,
  lang,
}) {
  const url = "https://payments.comgate.cz/v1.0/create";

  const params = new URLSearchParams();
  params.set("merchant", merchant);

  // backend => prepareOnly=true и secret обязателен
  params.set("prepareOnly", "true");
  params.set("secret", secret);

  params.set("test", test ? "true" : "false");
  params.set("country", "CZ");
  params.set("price", String(price)); // haléře
  params.set("curr", curr);
  params.set("label", label);
  params.set("refId", refId);
  params.set("method", method);

  if (email) params.set("email", email);
  if (phone) params.set("phone", phone);
  if (fullName) params.set("fullName", fullName);

  if (delivery) params.set("delivery", delivery);
  if (category) params.set("category", category);
  if (lang) params.set("lang", lang);

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const text = await r.text();

  const looksLikeQuery = text.includes("code=") || text.includes("&");
  if (!looksLikeQuery) {
    return {
      ok: false,
      raw: text,
      httpStatus: r.status,
    };
  }

  const data = Object.fromEntries(new URLSearchParams(text));
  const code = Number(data.code ?? 999);

  return {
    ok: r.ok && code === 0,
    data,
    httpStatus: r.status,
  };
}

// ✅ НУЖНОЕ: проверка статуса платежа
async function comgateGetStatus({ merchant, secret, test, transId }) {
  const url = "https://payments.comgate.cz/v1.0/status";

  const params = new URLSearchParams();
  params.set("merchant", merchant);
  params.set("secret", secret);
  params.set("test", test ? "true" : "false");
  params.set("transId", String(transId));

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const text = await r.text();
  const data = Object.fromEntries(new URLSearchParams(text));
  return { ok: r.ok, data, raw: text, httpStatus: r.status };
}

app.post("/api/checkout/init", async (req, res) => {
  try {
    const merchant = process.env.COMGATE_MERCHANT;
    const secret = process.env.COMGATE_SECRET;
    const test = (process.env.COMGATE_TEST || "false") === "true";
    const baseUrl = process.env.PUBLIC_BASE_URL || "https://www.elorajewelry.cz";

    if (!merchant || !secret) {
      return res.status(500).json({ message: "Set COMGATE_MERCHANT and COMGATE_SECRET in .env" });
    }

    const {
      fullName,
      email,
      phone,
      shipping,
      totalCzk,
      amountCzk,
      amount,
      packeta,
      address,
      items,
    } = req.body || {};

    if (!fullName) return res.status(400).json({ message: "fullName required" });
    if (!email && !phone) return res.status(400).json({ message: "email or phone required" });
    if (!shipping) return res.status(400).json({ message: "shipping required" });

    const isPickup = shipping === "cz_pickup" || shipping === "sk_pickup";
    const isHome = shipping === "cz_home" || shipping === "sk_home";

    if (isPickup && !packeta?.pointId) {
      return res.status(400).json({ message: "packeta.pointId required" });
    }

    if (isHome) {
      if (!address?.street || !address?.city || !address?.zip || !address?.country) {
        return res.status(400).json({ message: "address required (street, city, zip, country)" });
      }
    }

    const totalNum = Number(totalCzk ?? amountCzk ?? amount);
    if (!Number.isFinite(totalNum) || totalNum <= 0) {
      return res.status(400).json({ message: "totalCzk must be a positive number", got: totalCzk });
    }

    const price = Math.round(totalNum * 100); // haléře
    const refId = `elora-${Date.now()}`;

    const result = await comgateCreatePayment({
      merchant,
      secret,
      test,
      price,
      curr: "CZK",
      label: "ELORA",
      refId,
      method: "ALL",
      email: email || "",
      phone: phone || "",
      fullName,
      delivery: isPickup ? "PICKUP" : "DELIVERY",
      category: "PHYSICAL_GOODS_ONLY",
      lang: "cs",
    });

    if (!result.ok) {
      return res.status(502).json({
        message: "Comgate create payment failed",
        comgate: result.data || null,
        raw: result.raw || null,
        httpStatus: result.httpStatus,
      });
    }

    const transId = result.data.transId;

    orders.set(refId, {
      refId,
      transId,
      fullName,
      email: email || "",
      phone: phone || "",
      shipping,
      totalCzk: totalNum,
      packeta: isPickup ? packeta : null,
      address: isHome ? address : null,
      items: Array.isArray(items) ? items : [],
      paid: false,
      createdAt: new Date().toISOString(),
    });

    if (transId) transIdToRefId.set(String(transId), refId);

    return res.json({
      refId,
      transId,
      redirectUrl: result.data.redirect,
      shipping,
      totalCzk: totalNum,
      priceHalers: price,
      packeta: isPickup ? packeta : null,
      address: isHome ? address : null,
      returnUrls: {
        paid: `${baseUrl}/payment-success?refId=${encodeURIComponent(refId)}`,
        cancelled: `${baseUrl}/payment-failed?refId=${encodeURIComponent(refId)}`,
        pending: `${baseUrl}/payment-failed?refId=${encodeURIComponent(refId)}`,
      },
    });
  } catch (e) {
    return res.status(500).json({ message: e?.message || "Server error" });
  }
});

app.post("/api/comgate/notify", (req, res) => {
  res.status(200).send("OK");

  setImmediate(async () => {
    try {
      console.log("COMGATE NOTIFY:", req.body);

      const merchant = process.env.COMGATE_MERCHANT;
      const secret = process.env.COMGATE_SECRET;
      const test = (process.env.COMGATE_TEST || "false") === "true";

      const refId = req.body?.refId ? String(req.body.refId) : "";
      const transId = req.body?.transId ? String(req.body.transId) : "";

      let order = refId ? orders.get(refId) : null;

      if (!order && transId) {
        const mappedRef = transIdToRefId.get(transId);
        if (mappedRef) order = orders.get(mappedRef) || null;
      }

      const useTransId = transId || order?.transId;
      if (!useTransId) return;

      const statusRes = await comgateGetStatus({
        merchant,
        secret,
        test,
        transId: useTransId,
      });

      console.log("COMGATE STATUS:", statusRes.data);

      const status = String(statusRes.data?.status || "").toUpperCase();
      const isPaid = status === "PAID" || status === "AUTHORIZED";

      if (!isPaid) return;
      if (!order) {
        console.log("[WARN] Paid, but order not found. refId:", refId, "transId:", transId);
        return;
      }
      if (order.paid) return;

      order.paid = true;

      const ownerEmail = process.env.OWNER_EMAIL || "info.elorajewelry@gmail.com";

      await sendMail({
        to: ownerEmail,
        subject: `ELORA: New PAID order (${order.refId})`,
        html: `
          <h2>New order — PAID ✅</h2>
          <p><b>Order Ref:</b> ${order.refId}</p>
          <p><b>Comgate transId:</b> ${order.transId || "—"}</p>

          <h3>Customer</h3>
          <p><b>Name:</b> ${order.fullName}</p>
          <p><b>Email:</b> ${order.email || "—"}</p>
          <p><b>Phone:</b> ${order.phone || "—"}</p>

          <h3>Shipping</h3>
          <p><b>Method:</b> ${shippingToHuman(order.shipping)}</p>
          ${deliveryInfoHtml(order)}

          <h3>Items</h3>
          ${itemsToHtml(order.items)}

          <h3>Total</h3>
          <p><b>${formatCzk(order.totalCzk)}</b></p>

          <p style="opacity:.7;font-size:12px;">Created: ${order.createdAt}</p>
        `,
      });

      if (order.email) {
        await sendMail({
          to: order.email,
          subject: `ELORA: Order confirmed (${order.refId}) ✅`,
          html: `
            <h2>Děkujeme! Vaše platba proběhla úspěšně ✅</h2>
            <p>Vaše objednávka byla přijata.</p>

            <p><b>Objednávka:</b> ${order.refId}</p>
            <p><b>Částka:</b> <b>${formatCzk(order.totalCzk)}</b></p>
            <p><b>Doprava:</b> ${shippingToHuman(order.shipping)}</p>

            ${deliveryInfoHtml(order)}

            <h3>Položky</h3>
            ${itemsToHtml(order.items)}

            <p>Děkujeme za nákup.<br/>ELORA</p>
          `,
        });
      }
    } catch (e) {
      console.log("NOTIFY ASYNC ERROR:", e?.message || e);
    }
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Backend running on http://localhost:" + port));
