import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import nodemailer from "nodemailer";

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

// ✅ НУЖНОЕ: SMTP отправка писем
function createTransport() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) return null;

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

async function sendMail({ to, subject, html }) {
  const transporter = createTransport();
  if (!transporter) {
    console.log("[MAIL] SMTP env missing -> skip sending");
    return;
  }
  const from = process.env.SMTP_USER; // info.elorajewelry@gmail.com
  await transporter.sendMail({ from, to, subject, html });
}

function itemsToHtml(items = []) {
  if (!Array.isArray(items) || items.length === 0) return "<i>Items not provided</i>";
  const rows = items
    .map((i) => {
      const name = i?.name || "Produkt";
      const variant = i?.variant ? ` (${i.variant})` : "";
      const qty = Number(i?.qty || 1);
      const line = Number(i?.lineTotalCzk || 0);
      const price = line > 0 ? ` — ${line} CZK` : "";
      return `<li>${name}${variant} — qty: ${qty}${price}</li>`;
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
      items, // ✅ НУЖНОЕ
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

    // ✅ НУЖНОЕ: сохраняем заказ до notify (чтобы потом отправить email с товарами)
    orders.set(refId, {
      refId,
      transId: result.data.transId,
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

    return res.json({
      refId,
      transId: result.data.transId,
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

app.post("/api/comgate/notify", async (req, res) => {
  try {
    console.log("COMGATE NOTIFY:", req.body);

    const merchant = process.env.COMGATE_MERCHANT;
    const secret = process.env.COMGATE_SECRET;
    const test = (process.env.COMGATE_TEST || "false") === "true";

    const refId = req.body?.refId;
    const transId = req.body?.transId;

    const order = refId ? orders.get(refId) : null;
    const useTransId = transId || order?.transId;

    if (!useTransId) return res.status(200).send("OK");

    // ✅ НУЖНОЕ: проверяем статус у Comgate
    const statusRes = await comgateGetStatus({
      merchant,
      secret,
      test,
      transId: useTransId,
    });

    console.log("COMGATE STATUS:", statusRes.data);

    const status = String(statusRes.data?.status || "").toUpperCase();

    // ✅ НУЖНОЕ: считаем оплату прошедшей
    const isPaid = status === "PAID" || status === "AUTHORIZED";

    if (isPaid && order && !order.paid) {
      order.paid = true;

      const ownerEmail = process.env.OWNER_EMAIL || "danagrinenko@gmail.com";

      // 1) письмо владельцу
      await sendMail({
        to: ownerEmail,
        subject: `ELORA: New PAID order (${order.refId})`,
        html: `
          <h2>New order — PAID ✅</h2>
          <p><b>Ref:</b> ${order.refId}</p>
          <p><b>Name:</b> ${order.fullName}</p>
          <p><b>Email:</b> ${order.email}</p>
          <p><b>Phone:</b> ${order.phone}</p>
          <p><b>Shipping:</b> ${order.shipping}</p>
          <p><b>Total:</b> ${order.totalCzk} CZK</p>
          <h3>Items</h3>
          ${itemsToHtml(order.items)}
          <h3>Address</h3>
          <pre>${order.address ? JSON.stringify(order.address, null, 2) : "—"}</pre>
          <h3>Packeta</h3>
          <pre>${order.packeta ? JSON.stringify(order.packeta, null, 2) : "—"}</pre>
        `,
      });

      // 2) письмо клиенту
      if (order.email) {
        await sendMail({
          to: order.email,
          subject: `ELORA: Order confirmed (${order.refId}) ✅`,
          html: `
            <h2>Thank you! Your order is confirmed ✅</h2>
            <p><b>Order:</b> ${order.refId}</p>
            <p><b>Status:</b> PAID</p>
            <p><b>Total:</b> ${order.totalCzk} CZK</p>
            <h3>Items</h3>
            ${itemsToHtml(order.items)}
            <p>We will process your order and send it as soon as possible.</p>
          `,
        });
      }
    }

    return res.status(200).send("OK");
  } catch (e) {
    console.log("NOTIFY ERROR:", e?.message || e);
    // Comgate лучше всегда отвечать OK
    return res.status(200).send("OK");
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Backend running on http://localhost:" + port));
