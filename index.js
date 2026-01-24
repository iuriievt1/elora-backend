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

// ✅ временное хранилище заказов (MVP)
const orders = new Map();

// ✅ чтобы находить заказ по transId, если refId не пришёл
const transIdToRefId = new Map();

// ✅ Resend отправка писем
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

/**
 * Минимал-премиум шаблон письма (без кнопок)
 * Меняй бренд/тексты/стили тут, если захочешь ещё более “дорого”.
 */
function wrapEmail({ preheader = "", title, statusBadge = "", bodyHtml, footerHtml = "" }) {
  const safePreheader = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${preheader}</div>`
    : "";

  return `
  <!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <meta name="color-scheme" content="light only" />
      <title>${title}</title>
    </head>
    <body style="margin:0;padding:0;background:#f5f6f8;">
      ${safePreheader}

      <div style="padding:28px 14px;background:#f5f6f8;">
        <div style="max-width:640px;margin:0 auto;">
          <!-- Header -->
          <div style="padding:0 4px 12px;">
            <div style="font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
                        font-size:12px;letter-spacing:.18em;text-transform:uppercase;
                        color:#7a7f87;">
              ELORA JEWELRY
            </div>
          </div>

          <!-- Card -->
          <div style="background:#ffffff;border:1px solid #e9ebef;border-radius:18px;overflow:hidden;
                      box-shadow:0 8px 24px rgba(16,24,40,.06);">

            <div style="padding:18px 20px;border-bottom:1px solid #eef0f3;">
              <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
                <div style="font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
                            font-size:20px;font-weight:750;line-height:1.2;color:#111827;">
                  ${title}
                </div>
                ${statusBadge ? `
                  <span style="display:inline-block;padding:6px 10px;border-radius:999px;
                               background:#ecfdf3;border:1px solid #abefc6;color:#027a48;
                               font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
                               font-size:12px;font-weight:700;">
                    ${statusBadge}
                  </span>
                ` : ""}
              </div>
            </div>

            <div style="padding:18px 20px;color:#111827;
                        font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
                        font-size:14px;line-height:1.65;">
              ${bodyHtml}
            </div>

            <div style="padding:14px 20px;border-top:1px solid #eef0f3;color:#6b7280;
                        font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
                        font-size:12px;line-height:1.5;">
              ${footerHtml || "Если это письмо пришло по ошибке — просто проигнорируйте."}
            </div>
          </div>

          <!-- Tiny footer -->
          <div style="padding:14px 4px 0;color:#9aa0a6;font-size:11px;
                      font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;">
            © ${new Date().getFullYear()} ELORA
          </div>
        </div>
      </div>
    </body>
  </html>`;
}

function sectionCard({ title, html }) {
  return `
    <div style="margin-top:14px;padding:14px 14px;background:#fafafa;border:1px solid #eef0f3;border-radius:14px;">
      <div style="font-weight:750;color:#111827;margin-bottom:8px;">${title}</div>
      <div style="color:#111827;">${html}</div>
    </div>
  `;
}

function row(label, value) {
  return `
    <div style="margin-top:6px;">
      <span style="color:#6b7280;">${label}</span>
      <span style="color:#111827;font-weight:650;margin-left:6px;">${value}</span>
    </div>
  `;
}

async function sendMail({ to, subject, html }) {
  if (!resend) {
    console.log("[MAIL] RESEND_API_KEY missing -> skip sending");
    return;
  }

  const from = process.env.MAIL_FROM || "orders@elorajewelry.cz";

  try {
    const resp = await resend.emails.send({
      from,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
    });

    if (resp?.error) {
      console.log("[MAIL] resend error:", resp.error);
      return;
    }

    console.log(
      `[MAIL] sent -> ${Array.isArray(to) ? to.join(",") : to} | ${subject} | id: ${
        resp?.data?.id || resp?.id || "-"
      }`
    );
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
    case "cz_pickup":
      return "CZ — Z-Point/Z-Box (Pickup)";
    case "cz_home":
      return "CZ — Domů (Delivery)";
    case "sk_pickup":
      return "SK — Z-Point/Z-Box (Pickup)";
    case "sk_home":
      return "SK — Domů (Delivery)";
    default:
      return shipping || "—";
  }
}

function deliveryInfoHtml(order) {
  if (order.packeta?.pointId) {
    const name = order.packeta?.name || "";
    const addr = order.packeta?.address || "";
    const nameLine = name ? `<div style="margin-top:6px;"><span style="color:#6b7280;">Name</span><span style="font-weight:650;margin-left:6px;">${name}</span></div>` : "";
    const addrLine = addr ? `<div style="margin-top:6px;"><span style="color:#6b7280;">Address</span><span style="font-weight:650;margin-left:6px;">${addr}</span></div>` : "";
    return sectionCard({
      title: "Pickup point (Zásilkovna)",
      html: `
        ${row("ID", order.packeta.pointId)}
        ${nameLine}
        ${addrLine}
      `,
    });
  }

  if (order.address?.street) {
    return sectionCard({
      title: "Delivery address",
      html: `
        <div style="font-weight:650;">
          ${order.address.street}<br/>
          ${order.address.city} ${order.address.zip}<br/>
          ${order.address.country}
        </div>
      `,
    });
  }

  return sectionCard({
    title: "Delivery info",
    html: `<div style="color:#6b7280;">—</div>`,
  });
}

function itemsToHtml(items = []) {
  if (!Array.isArray(items) || items.length === 0) {
    return `<div style="color:#6b7280;"><i>Items not provided</i></div>`;
  }

  const rows = items
    .map((i) => {
      const name = i?.name || "Produkt";
      const variant = i?.variant ? ` (${i.variant})` : "";
      const qty = Number(i?.qty || 1);
      const line = Number(i?.lineTotalCzk || 0);
      const price = line > 0 ? ` — <span style="font-weight:750;">${formatCzk(line)}</span>` : "";
      return `
        <div style="padding:10px 0;border-top:1px solid #eef0f3;">
          <div style="font-weight:750;">${name}${variant}</div>
          <div style="margin-top:4px;color:#6b7280;">
            qty: <span style="font-weight:650;color:#111827;">${qty}</span>${price}
          </div>
        </div>
      `;
    })
    .join("");

  return `<div style="border:1px solid #eef0f3;border-radius:14px;overflow:hidden;background:#fff;padding:0 14px;">${rows}</div>`;
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
    return { ok: false, raw: text, httpStatus: r.status };
  }

  const data = Object.fromEntries(new URLSearchParams(text));
  const code = Number(data.code ?? 999);

  return { ok: r.ok && code === 0, data, httpStatus: r.status };
}

// ✅ проверка статуса платежа
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

    const { fullName, email, shipping, totalCzk, amountCzk, amount, packeta, address, items } =
      req.body || {};

    if (!fullName) return res.status(400).json({ message: "fullName required" });

    // ✅ телефон не нужен — требуем только email
    if (!email) return res.status(400).json({ message: "email required" });

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

    // ✅ phone не передаем в Comgate
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

    // ✅ phone не храним
    orders.set(refId, {
      refId,
      transId,
      fullName,
      email: email || "",
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

      // ✅ ПИСЬМО ПРОДАВЦУ (минимал-премиум)
      await sendMail({
        to: ownerEmail,
        subject: `ELORA: New PAID order (${order.refId})`,
        html: wrapEmail({
          preheader: `New paid order ${order.refId}`,
          title: "New order",
          statusBadge: "PAID ✅",
          bodyHtml: `
            ${sectionCard({
              title: "Order",
              html: `
                ${row("Ref", order.refId)}
                ${row("Comgate transId", order.transId || "—")}
                ${row("Total", formatCzk(order.totalCzk))}
                ${row("Shipping", shippingToHuman(order.shipping))}
                <div style="margin-top:10px;color:#9aa0a6;font-size:12px;">Created: ${order.createdAt}</div>
              `,
            })}

            ${sectionCard({
              title: "Customer",
              html: `
                ${row("Name", order.fullName)}
                ${row("Email", order.email || "—")}
              `,
            })}

            ${deliveryInfoHtml(order)}

            <div style="margin-top:16px;">
              <div style="font-weight:750;margin-bottom:10px;">Items</div>
              ${itemsToHtml(order.items)}
            </div>
          `,
          footerHtml: `ELORA • уведомление о заказе`,
        }),
      });

      // ✅ ПИСЬМО ПОКУПАТЕЛЮ (минимал-премиум)
      if (order.email) {
        await sendMail({
          to: order.email,
          subject: `ELORA: Order confirmed (${order.refId}) ✅`,
          html: wrapEmail({
            preheader: `Platba úspěšná • Objednávka ${order.refId}`,
            title: "Děkujeme!",
            statusBadge: "Payment successful ✅",
            bodyHtml: `
              <div style="color:#111827;">
                Vaše objednávka byla přijata.
              </div>

              ${sectionCard({
                title: "Summary",
                html: `
                  ${row("Objednávka", order.refId)}
                  ${row("Částka", formatCzk(order.totalCzk))}
                  ${row("Doprava", shippingToHuman(order.shipping))}
                `,
              })}

              ${deliveryInfoHtml(order)}

              <div style="margin-top:16px;">
                <div style="font-weight:750;margin-bottom:10px;">Položky</div>
                ${itemsToHtml(order.items)}
              </div>

              <div style="margin-top:16px;color:#111827;">
                Děkujeme za nákup.<br/>
                <span style="font-weight:750;">ELORA</span>
              </div>
            `,
            footerHtml: `Если письма нет во “Входящие”, проверь “Промоакции/Спам”.`,
          }),
        });
      }
    } catch (e) {
      console.log("NOTIFY ASYNC ERROR:", e?.message || e);
    }
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Backend running on http://localhost:" + port));
