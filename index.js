import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const app = express();

// Чтобы Comgate callback (POST) читался нормально:
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// На тесте можно "*", потом сделаем строго.
app.use(cors({ origin: "*" }));

app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * Comgate возвращает НЕ JSON, а urlencoded строку вида:
 * code=0&message=OK&transId=...&redirect=...
 */
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

  // ВАЖНО:
  // Мы создаём платеж "на позadí" (backend) => prepareOnly=true и secret ОБЯЗАТЕЛЕН
  params.set("prepareOnly", "true");
  params.set("secret", secret);

  params.set("test", test ? "true" : "false");
  params.set("country", "CZ");
  params.set("price", String(price)); // в haléřích
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

  // Comgate может вернуть 302/HTML при ошибке, поэтому читаем как текст.
  const text = await r.text();

  // Если это НЕ urlencoded, вернем как есть, чтобы ты видел причину
  const looksLikeQuery = text.includes("code=") || text.includes("&");
  if (!looksLikeQuery) {
    return {
      ok: false,
      raw: text,
      httpStatus: r.status,
    };
  }

  const data = Object.fromEntries(new URLSearchParams(text));

  // code=0 => OK
  const code = Number(data.code ?? 999);

  return {
    ok: r.ok && code === 0,
    data,
    httpStatus: r.status,
  };
}

app.post("/api/checkout/init", async (req, res) => {
  try {
    const merchant = process.env.COMGATE_MERCHANT;
    const secret = process.env.COMGATE_SECRET;
    const test = (process.env.COMGATE_TEST || "false") === "true";

    // Это базовый домен ФРОНТА (твоя Webflow-страница)
    const baseUrl = process.env.PUBLIC_BASE_URL || "https://www.elorajewelry.cz";

    if (!merchant || !secret) {
      return res.status(500).json({
        message: "Set COMGATE_MERCHANT and COMGATE_SECRET in .env",
      });
    }

    const { fullName, email, phone, packeta } = req.body || {};

    if (!fullName) return res.status(400).json({ message: "fullName required" });
    if (!email && !phone)
      return res.status(400).json({ message: "email or phone required" });

    if (!packeta?.pointId)
      return res.status(400).json({ message: "packeta.pointId required" });

    // Пока тест: 100 CZK = 10000 haléřů
    const price = 10000;
    const curr = "CZK";
    const refId = `elora-${Date.now()}`;

    const result = await comgateCreatePayment({
      merchant,
      secret,
      test,
      price,
      curr,
      label: "ELORA",
      refId,
      method: "ALL",
      email: email || "",
      phone: phone || "",
      fullName,
      delivery: "PICKUP",
      category: "PHYSICAL_GOODS_ONLY",
      lang: "cs",
    });

    if (!result.ok) {
      return res.status(502).json({
        message: "Comgate create payment failed",
        comgate: result.data || null,
        raw: result.raw || null,
        httpStatus: result.httpStatus,
        hint:
          "Check allowed IP in Comgate portal (Povolené IP adresy) + correct merchant/secret + test mode.",
      });
    }

    // redirect URL — то, что надо открыть пользователю
    return res.json({
      refId,
      transId: result.data.transId,
      redirectUrl: result.data.redirect,
      // На будущее (успех/ошибка):
      returnUrls: {
        paid: `${baseUrl}/payment-success?refId=${encodeURIComponent(refId)}`,
        cancelled: `${baseUrl}/payment-failed?refId=${encodeURIComponent(refId)}`,
        pending: `${baseUrl}/payment-failed?refId=${encodeURIComponent(refId)}`,
      },
      packeta,
    });
  } catch (e) {
    return res.status(500).json({ message: e?.message || "Server error" });
  }
});


app.post("/api/comgate/notify", (req, res) => {
  // Comgate обычно шлет transId, refId, status и т.д.
  console.log("COMGATE NOTIFY:", req.body);
  // В реале: здесь проверяем подпись/статус через /status и сохраняем заказ
  return res.status(200).send("OK");
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Backend running on http://localhost:" + port));
