require("dotenv").config({ path: require("node:path").join(__dirname, ".env") });
const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { User, Product, Invoice, Movement, Payment, Deposit, Expense, CashEntry, Settings } = require("./models");

const app = express();
const api = express.Router();
const origins = (process.env.CORS_ORIGINS || "http://localhost:3000,http://127.0.0.1:3000").split(",").map((s) => s.trim());
app.use(cors({ origin: origins.includes("*") ? true : origins, credentials: true }));
app.use(express.json());
app.use(cookieParser());

function fail(status, detail) {
  const error = new Error(detail);
  error.status = status;
  throw error;
}
function number(value, name, min = -Infinity) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) fail(400, `${name} invalide`);
  return value;
}
function text(value, name) {
  if (typeof value !== "string" || !value.trim()) fail(400, `${name} requis`);
  return value;
}
function token(user) {
  return jwt.sign({ sub: user.id, email: user.email, type: "access" }, process.env.JWT_SECRET, { expiresIn: "7d" });
}
function setCookie(req, res, value) {
  const secure = req.secure || req.get("x-forwarded-proto") === "https";
  res.cookie("access_token", value, { httpOnly: true, secure, sameSite: secure ? "none" : "lax", maxAge: 7 * 86400000, path: "/" });
}
function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}
async function transaction(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await fn(session); });
    return result;
  } finally {
    await session.endSession();
  }
}
async function settings(session) {
  return Settings.findOneAndUpdate(
    { id: "shop" },
    { $setOnInsert: { id: "shop", shop_name: "Wayire | Mel | Butembo", shop_address: process.env.SHOP_ADDRESS || "", shop_phone: process.env.SHOP_PHONE || "", credit_limit: Number(process.env.CREDIT_LIMIT || 10000), cash_balance: 0 } },
    { upsert: true, new: true, session, setDefaultsOnInsert: true }
  );
}
function productInput(body) {
  return {
    name: text(body.name, "Nom"), sku: body.sku || "", category: body.category || "",
    price: number(body.price, "Prix", 0), cost: number(body.cost ?? 0, "Coût", 0),
    stock: number(body.stock ?? 0, "Stock", 0),
    low_stock_threshold: number(body.low_stock_threshold ?? 5, "Seuil", 0),
  };
}

api.post("/auth/register", async (req, res) => {
  const email = text(req.body.email, "Email").trim().toLowerCase();
  const name = text(req.body.name, "Nom");
  const password = text(req.body.password, "Mot de passe");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, "Email invalide");
  if (await User.exists({ email })) fail(400, "Email déjà utilisé");
  const user = await User.create({ email, name, password_hash: await bcrypt.hash(password, 10) });
  setCookie(req, res, token(user));
  res.json(publicUser(user));
});
api.post("/auth/login", async (req, res) => {
  const email = text(req.body.email, "Email").trim().toLowerCase();
  const password = text(req.body.password, "Mot de passe");
  const user = await User.findOne({ email }).select("+password_hash");
  if (!user || !(await bcrypt.compare(password, user.password_hash))) fail(401, "Email ou mot de passe incorrect");
  setCookie(req, res, token(user));
  res.json(publicUser(user));
});
api.post("/auth/logout", (req, res) => {
  res.clearCookie("access_token", { path: "/" });
  res.json({ ok: true });
});
api.get("/", (req, res) => res.json({ message: "Wayire | Mel | Butembo API" }));
api.use(async (req, res, next) => {
  const bearer = req.get("authorization");
  const value = req.cookies.access_token || (bearer && bearer.startsWith("Bearer ") ? bearer.slice(7) : null);
  if (!value) return res.status(401).json({ detail: "Non authentifié" });
  let payload;
  try { payload = jwt.verify(value, process.env.JWT_SECRET, { algorithms: ["HS256"] }); }
  catch (error) { return res.status(401).json({ detail: error.name === "TokenExpiredError" ? "Token expiré" : "Token invalide" }); }
  if (payload.type !== "access") return res.status(401).json({ detail: "Token invalide" });
  req.user = await User.findOne({ id: payload.sub });
  if (!req.user) return res.status(401).json({ detail: "Utilisateur introuvable" });
  next();
});
api.get("/auth/me", (req, res) => res.json(publicUser(req.user)));

api.get("/products", async (req, res) => res.json(await Product.find().sort({ name: 1 })));
api.post("/products", async (req, res) => {
  const data = productInput(req.body);
  const product = await transaction(async (session) => {
    const [p] = await Product.create([data], { session });
    if (p.stock > 0) await Movement.create([{ product_id: p.id, qty: p.stock, reason: "Stock initial", user_id: req.user.id, created_at: p.created_at }], { session });
    return p;
  });
  res.json(product);
});
api.put("/products/:id", async (req, res) => {
  const product = await Product.findOneAndUpdate({ id: req.params.id }, productInput(req.body), { new: true, runValidators: true });
  if (!product) fail(404, "Produit introuvable");
  res.json(product);
});
api.delete("/products/:id", async (req, res) => {
  await transaction(async (session) => {
    const product = await Product.findOneAndDelete({ id: req.params.id }, { session });
    if (!product) fail(404, "Produit introuvable");
    await Invoice.updateMany({ "items.product_id": product.id }, { $pull: { items: { product_id: product.id } } }, { session });
    await Movement.deleteMany({ product_id: product.id }, { session });
  });
  res.json({ ok: true });
});
api.post("/products/:id/movement", async (req, res) => {
  const qty = number(req.body.qty, "Quantité");
  const product = await transaction(async (session) => {
    const p = await Product.findOneAndUpdate({ id: req.params.id, stock: { $gte: -qty } }, { $inc: { stock: qty } }, { new: true, session });
    if (!p) {
      if (!(await Product.exists({ id: req.params.id }).session(session))) fail(404, "Produit introuvable");
      fail(400, "Stock insuffisant");
    }
    await Movement.create([{ product_id: p.id, qty, reason: req.body.reason || "", user_id: req.user.id }], { session });
    return p;
  });
  res.json({ ok: true, stock: product.stock });
});
api.get("/products/:id/history", async (req, res) => {
  const invoices = await Invoice.find({ "items.product_id": req.params.id }).sort({ created_at: -1 });
  res.json(invoices.flatMap((inv) => inv.items.filter((item) => item.product_id === req.params.id).map((item) => ({
    invoice_id: inv.id, invoice_number: inv.number, customer_name: inv.customer_name,
    qty: item.qty, price: item.price, total: item.price * item.qty, payment_method: inv.payment_method,
    operator_name: inv.operator_name, created_at: inv.created_at,
  }))));
});

api.get("/invoices", async (req, res) => res.json(await Invoice.find().sort({ created_at: -1 })));
api.post("/invoices", async (req, res) => {
  const data = req.body;
  if (!Array.isArray(data.items) || !data.items.length) fail(400, "Au moins un article requis");
  const items = data.items.map((item) => ({
    product_id: text(item.product_id, "Produit"), name: text(item.name, "Nom du produit"),
    price: number(item.price, "Prix", 0), qty: number(item.qty, "Quantité", Number.EPSILON),
  }));
  const discount = number(data.discount ?? 0, "Remise", 0);
  const depositAmount = number(data.deposit_amount ?? 0, "Avance", 0);
  const method = data.payment_method === "credit" ? "credit" : "cash";
  const customerName = data.customer_name || "";
  if (method === "credit" && !customerName.trim()) fail(400, "Nom du client requis pour un crédit");
  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  if (depositAmount > Math.max(subtotal - discount, 0)) fail(400, "Avance supérieure au montant de la facture");
  if (depositAmount > 0 && !data.deposit_id) fail(400, "Avance introuvable");
  const total = Math.max(subtotal - discount - depositAmount, 0);
  const invoice = await transaction(async (session) => {
    const date = new Date();
    const invoiceNumber = `FAC-${date.toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    for (const item of items) {
      const p = await Product.findOneAndUpdate({ id: item.product_id, stock: { $gte: item.qty } }, { $inc: { stock: -item.qty } }, { new: true, session });
      if (!p) fail(400, `Stock insuffisant ou produit ${item.name} introuvable`);
      await Movement.create([{ product_id: p.id, qty: -item.qty, reason: `Vente ${invoiceNumber}`, user_id: req.user.id, created_at: date }], { session });
    }
    if (depositAmount > 0) {
      const deposit = await Deposit.findOneAndUpdate({ id: data.deposit_id, remaining: { $gte: depositAmount } }, { $inc: { remaining: -depositAmount } }, { session });
      if (!deposit) fail(400, "Avance introuvable ou montant insuffisant");
    }
    const paid = method === "cash" ? total : 0;
    const [inv] = await Invoice.create([{ number: invoiceNumber, customer_name: customerName, customer_phone: data.customer_phone || "", items, subtotal, discount, total, paid_amount: paid, balance: total - paid, status: total - paid <= 0 ? "paid" : "unpaid", payment_method: method, operator_name: req.user.name, deposit_id: data.deposit_id || null, deposit_amount: depositAmount, user_id: req.user.id, created_at: date }], { session });
    if (paid > 0) {
      const s = await settings(session);
      await Settings.updateOne({ id: s.id }, { $inc: { cash_balance: paid } }, { session });
    }
    return inv;
  });
  res.json(invoice);
});
api.delete("/invoices/:id", async (req, res) => {
  await transaction(async (session) => {
    const invoice = await Invoice.findOneAndDelete({ id: req.params.id }, { session });
    if (!invoice) fail(404, "Facture introuvable");
    const payments = await Payment.find({ invoice_id: invoice.id }).session(session);
    await Payment.deleteMany({ invoice_id: invoice.id }, { session });
    const s = await settings(session);
    const cash = (invoice.payment_method === "cash" ? invoice.total : 0) + payments.reduce((sum, p) => sum + p.amount, 0);
    await Settings.updateOne({ id: s.id }, { $inc: { cash_balance: -cash } }, { session });
    if (invoice.deposit_id && invoice.deposit_amount > 0) await Deposit.updateOne({ id: invoice.deposit_id }, { $inc: { remaining: invoice.deposit_amount } }, { session });
    for (const item of invoice.items) {
      const product = await Product.findOneAndUpdate({ id: item.product_id }, { $inc: { stock: item.qty } }, { session });
      if (product) await Movement.create([{ product_id: item.product_id, qty: item.qty, reason: `Annulation facture ${invoice.number}`, user_id: req.user.id }], { session });
    }
  });
  res.json({ ok: true });
});

api.get("/credits/customers", async (req, res) => {
  const s = await settings();
  const invoices = await Invoice.find({ balance: { $gt: 0 } });
  const customers = new Map();
  for (const inv of invoices) {
    const c = customers.get(inv.customer_name) || { name: inv.customer_name, phone: inv.customer_phone, total_due: 0, invoice_count: 0, last_date: inv.created_at };
    c.total_due += inv.balance;
    c.invoice_count++;
    if (inv.created_at > c.last_date) c.last_date = inv.created_at;
    customers.set(inv.customer_name, c);
  }
  res.json({ limit: s.credit_limit, customers: [...customers.values()].map((c) => ({ ...c, over_limit: c.total_due >= s.credit_limit, near_limit: c.total_due >= s.credit_limit * 0.8 && c.total_due < s.credit_limit, limit: s.credit_limit })).sort((a, b) => b.total_due - a.total_due) });
});
api.get("/credits/check", async (req, res) => {
  const s = await settings();
  const invoices = await Invoice.find({ customer_name: req.query.customer_name, balance: { $gt: 0 } });
  const current = invoices.reduce((sum, i) => sum + i.balance, 0);
  const amount = Number(req.query.amount || 0);
  if (!Number.isFinite(amount)) fail(400, "Montant invalide");
  const projected = current + amount;
  res.json({ customer_name: req.query.customer_name, limit: s.credit_limit, current_balance: current, projected_balance: projected, over_limit: projected > s.credit_limit, near_limit: projected >= s.credit_limit * 0.8 && projected <= s.credit_limit });
});
api.get("/credits", async (req, res) => res.json(await Invoice.find({ balance: { $gt: 0 } }).sort({ created_at: -1 })));
api.post("/credits/payment", async (req, res) => {
  const amount = number(req.body.amount, "Montant", Number.EPSILON);
  const result = await transaction(async (session) => {
    const inv = await Invoice.findOne({ id: req.body.invoice_id }).session(session);
    if (!inv) fail(404, "Facture introuvable");
    if (amount > inv.balance) fail(400, "Le montant saisi dépasse le reste à payer");
    inv.paid_amount += amount;
    inv.balance = inv.total - inv.paid_amount;
    inv.status = inv.balance <= 0 ? "paid" : "partial";
    await inv.save({ session });
    await Payment.create([{ invoice_id: inv.id, amount, note: req.body.note || "", user_id: req.user.id }], { session });
    const s = await settings(session);
    await Settings.updateOne({ id: s.id }, { $inc: { cash_balance: amount } }, { session });
    return { ok: true, balance: inv.balance, status: inv.status };
  });
  res.json(result);
});
api.get("/credits/:id/payments", async (req, res) => res.json(await Payment.find({ invoice_id: req.params.id }).sort({ created_at: -1 })));

api.post("/deposits", async (req, res) => {
  const data = req.body;
  const amount = number(data.amount, "Montant", Number.EPSILON);
  const deposit = await transaction(async (session) => {
    const [d] = await Deposit.create([{ customer_name: text(data.customer_name, "Client"), customer_phone: data.customer_phone || "", product_name: text(data.product_name, "Produit"), amount, remaining: amount, note: data.note || "", user_id: req.user.id }], { session });
    const s = await settings(session);
    await Settings.updateOne({ id: s.id }, { $inc: { cash_balance: amount } }, { session });
    return d;
  });
  res.json(deposit);
});
api.get("/deposits/customer/:name", async (req, res) => res.json(await Deposit.find({ customer_name: req.params.name, remaining: { $gt: 0 } }).sort({ created_at: -1 })));
api.get("/deposits", async (req, res) => res.json(await Deposit.find({ remaining: { $gt: 0 } }).sort({ created_at: -1 })));
api.post("/deposits/:id/use", async (req, res) => {
  const amount = number(Number(req.query.amount), "Montant", Number.EPSILON);
  const deposit = await Deposit.findOneAndUpdate({ id: req.params.id, remaining: { $gte: amount } }, { $inc: { remaining: -amount } }, { new: true });
  if (!deposit) fail(400, "Avance introuvable ou montant insuffisant");
  res.json({ ok: true, remaining: deposit.remaining });
});
api.delete("/deposits/:id", async (req, res) => {
  await transaction(async (session) => {
    const deposit = await Deposit.findOneAndDelete({ id: req.params.id }, { session });
    if (!deposit) fail(404, "Avance introuvable");
    const s = await settings(session);
    await Settings.updateOne({ id: s.id }, { $inc: { cash_balance: -deposit.amount } }, { session });
  });
  res.json({ message: "Avance supprimée" });
});
api.post("/expenses", async (req, res) => {
  const description = text(req.body.description, "Description");
  const amount = number(req.body.amount, "Montant", Number.EPSILON);
  const debt = number(req.body.debt ?? 0, "Dette", 0);
  if (debt > amount) fail(400, "Dette invalide");
  const expense = await transaction(async (session) => {
    const [e] = await Expense.create([{ description, amount, debt, paid_cash: amount - debt, user_id: req.user.id }], { session });
    const s = await settings(session);
    await Settings.updateOne({ id: s.id }, { $inc: { cash_balance: -e.paid_cash } }, { session });
    return e;
  });
  res.json({ ...expense.toJSON(), user_name: req.user.name });
});
async function expensesWithNames(expenses) {
  const users = await User.find({ id: { $in: expenses.map((e) => e.user_id) } });
  const names = new Map(users.map((u) => [u.id, u.name]));
  return expenses.map((e) => ({ ...e.toJSON(), user_name: names.get(e.user_id) || "—" }));
}
api.get("/expenses", async (req, res) => res.json(await expensesWithNames(await Expense.find().sort({ created_at: -1 }))));
api.delete("/expenses/:id", async (req, res) => {
  await transaction(async (session) => {
    const expense = await Expense.findOneAndDelete({ id: req.params.id }, { session });
    if (!expense) fail(404, "Dépense introuvable");
    const s = await settings(session);
    await Settings.updateOne({ id: s.id }, { $inc: { cash_balance: expense.paid_cash } }, { session });
  });
  res.json({ message: "Dépense supprimée" });
});

api.get("/cash-entries", async (req, res) => {
  res.json(await CashEntry.find().sort({ date: -1, created_at: -1, id: -1 }));
});
api.post("/cash-entries", async (req, res) => {
  const destination = text(req.body.destination, "Destination").trim();
  const reason = text(req.body.reason, "Motif").trim();
  const amount = number(req.body.amount, "Montant", Number.EPSILON);
  const date = text(req.body.date, "Date");
  dayBounds(date);
  const entry = await transaction(async (session) => {
    const [created] = await CashEntry.create([{ destination, reason, amount, date, user_id: req.user.id, user_name: req.user.name }], { session });
    const s = await settings(session);
    await Settings.updateOne({ id: s.id }, { $inc: { cash_balance: amount } }, { session });
    return created;
  });
  res.json(entry);
});
api.delete("/cash-entries/:id", async (req, res) => {
  await transaction(async (session) => {
    const entry = await CashEntry.findOneAndDelete({ id: req.params.id }, { session });
    if (!entry) fail(404, "Entrée de caisse introuvable");
    const s = await settings(session);
    await Settings.updateOne({ id: s.id }, { $inc: { cash_balance: -entry.amount } }, { session });
  });
  res.json({ ok: true });
});

function dayString(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function dayBounds(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(400, "Date invalide");
  const start = new Date(`${value}T00:00:00`);
  if (Number.isNaN(start.getTime()) || dayString(start) !== value) fail(400, "Date invalide");
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { $gte: start, $lt: end };
}
function sortedCounts(counts) {
  return [...counts.entries()].map(([name, qty]) => ({ name, qty })).sort((a, b) => b.qty - a.qty);
}
api.get("/reports/summary", async (req, res) => {
  const [products, invoices] = await Promise.all([Product.find(), Invoice.find()]);
  const daily = new Map();
  for (let n = 6; n >= 0; n--) {
    const date = new Date();
    date.setDate(date.getDate() - n);
    daily.set(dayString(date), 0);
  }
  const counts = new Map();
  const todayCounts = new Map();
  const today = dayString(new Date());
  for (const inv of invoices) {
    const date = dayString(inv.created_at);
    if (daily.has(date)) daily.set(date, daily.get(date) + inv.total);
    for (const item of inv.items) {
      counts.set(item.name, (counts.get(item.name) || 0) + item.qty);
      if (date === today) todayCounts.set(item.name, (todayCounts.get(item.name) || 0) + item.qty);
    }
  }
  const low = products.filter((p) => p.stock <= p.low_stock_threshold);
  res.json({
    stock_value: products.reduce((sum, p) => sum + p.price * p.stock, 0),
    cost_value: products.reduce((sum, p) => sum + p.cost * p.stock, 0),
    low_stock_count: low.length, low_stock: low.slice(0, 10), total_products: products.length,
    total_invoices: invoices.length, total_sales: invoices.reduce((sum, i) => sum + i.total, 0),
    total_paid: invoices.reduce((sum, i) => sum + i.paid_amount, 0),
    total_credit: invoices.reduce((sum, i) => sum + i.balance, 0),
    daily_sales: [...daily.entries()].map(([date, total]) => ({ date, total })),
    top_products: sortedCounts(counts).slice(0, 5), daily_products: sortedCounts(todayCounts),
  });
});
api.get("/reports/product-movements", async (req, res) => {
  const product = await Product.findOne({ id: req.query.product_id });
  if (!product) fail(404, "Produit introuvable");
  const query = { product_id: product.id };
  if (req.query.date) query.created_at = dayBounds(req.query.date);
  const movements = await Movement.find(query).sort({ created_at: 1 });
  const users = await User.find({ id: { $in: movements.map((m) => m.user_id) } });
  const names = new Map(users.map((u) => [u.id, u.name]));
  const invoiceNumbers = movements.filter((m) => (m.reason || "").startsWith("Vente ")).map((m) => m.reason.slice(6));
  const invoices = await Invoice.find({ number: { $in: invoiceNumbers } });
  const customers = new Map(invoices.map((i) => [i.number, i.customer_name]));
  let balance = 0, totalIn = 0, totalOut = 0;
  const ledger = movements.map((m) => {
    balance += m.qty;
    if (m.qty >= 0) totalIn += m.qty; else totalOut -= m.qty;
    return { id: m.id, date: m.created_at, qty: m.qty, kind: m.qty >= 0 ? "in" : "out", reason: m.reason, operator: names.get(m.user_id) || "—", balance, customer: customers.get((m.reason || "").slice(6)) || "—" };
  });
  res.json({ product, total_in: totalIn, total_out: totalOut, movements_count: movements.length, ledger: ledger.reverse() });
});
api.get("/reports/daily", async (req, res) => {
  const date = req.query.date || dayString(new Date());
  const range = dayBounds(date);
  const [invoices, expenses, s] = await Promise.all([
    Invoice.find({ created_at: range }).sort({ created_at: 1 }),
    Expense.find({ created_at: range }).sort({ created_at: 1 }), settings(),
  ]);
  const cash = invoices.filter((i) => i.payment_method === "cash");
  const credit = invoices.filter((i) => i.payment_method === "credit");
  const totalCash = cash.reduce((sum, i) => sum + i.total, 0);
  const totalCredit = credit.reduce((sum, i) => sum + i.total, 0);
  const operators = new Map();
  const items = new Map();
  for (const inv of invoices) {
    const name = inv.operator_name || "—";
    const operator = operators.get(name) || { name, count: 0, cash: 0, credit: 0 };
    operator.count++;
    operator[inv.payment_method === "cash" ? "cash" : "credit"] += inv.total;
    operators.set(name, operator);
    for (const item of inv.items) {
      const current = items.get(item.name) || { name: item.name, qty: 0, total: 0 };
      current.qty += item.qty;
      current.total += item.price * item.qty;
      items.set(item.name, current);
    }
  }
  res.json({
    date, total_sales: totalCash + totalCredit, total_cash: totalCash, total_credit: totalCredit,
    total_expenses: expenses.reduce((sum, e) => sum + e.amount, 0),
    total_cash_expenses: expenses.reduce((sum, e) => sum + e.paid_cash, 0),
    cash_balance: s.cash_balance, cash_count: cash.length, credit_count: credit.length,
    invoice_count: invoices.length, invoices, expenses: await expensesWithNames(expenses),
    by_operator: [...operators.values()], top_items: [...items.values()].sort((a, b) => b.qty - a.qty),
  });
});
api.get("/shop/info", async (req, res) => {
  const s = await settings();
  res.json({ name: s.shop_name, address: s.shop_address, phone: s.shop_phone });
});
api.get("/settings", async (req, res) => {
  const s = await settings();
  res.json({ shop_name: s.shop_name, shop_address: s.shop_address, shop_phone: s.shop_phone, credit_limit: s.credit_limit, cash_balance: s.cash_balance });
});
api.put("/settings", async (req, res) => {
  const body = req.body;
  const data = { shop_name: text(body.shop_name, "Nom"), shop_address: body.shop_address || "", shop_phone: body.shop_phone || "", credit_limit: number(body.credit_limit ?? 10000, "Limite", 0) };
  if (body.cash_balance !== undefined) data.cash_balance = number(body.cash_balance, "Caisse");
  await settings();
  const s = await Settings.findOneAndUpdate({ id: "shop" }, data, { new: true });
  res.json({ shop_name: s.shop_name, shop_address: s.shop_address, shop_phone: s.shop_phone, credit_limit: s.credit_limit, cash_balance: s.cash_balance });
});
app.use("/api", api);
app.use("/api", (req, res) => res.status(404).json({ detail: "Route introuvable" }));
const frontendBuild = path.join(__dirname, "..", "frontend", "build");
app.use(express.static(frontendBuild));
app.get(/.*/, (req, res, next) => {
  res.sendFile(path.join(frontendBuild, "index.html"), (err) => {
    if (err) next(err);
  });
});
app.use((err, req, res, next) => {
  if (err.code === 11000) return res.status(400).json({ detail: "Cette valeur existe déjà" });
  if (err.name === "ValidationError") return res.status(400).json({ detail: err.message });
  if (err.status && err.status < 500) return res.status(err.status).json({ detail: err.message });
  console.error("Erreur API:", err);
  res.status(500).json({ detail: "Erreur interne du serveur" });
});

async function start() {
  if (!process.env.MONGODB_URI || !process.env.JWT_SECRET) throw new Error("MONGODB_URI et JWT_SECRET sont requis");
  await mongoose.connect(process.env.MONGODB_URI);
  await Promise.all([User.init(), Product.init(), Invoice.init(), Movement.init(), Payment.init(), Deposit.init(), Expense.init(), CashEntry.init(), Settings.init()]);
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const email = process.env.ADMIN_EMAIL.toLowerCase();
    if (!(await User.exists({ email }))) {
      await User.create({ email, name: "Admin", password_hash: await bcrypt.hash(process.env.ADMIN_PASSWORD, 10), role: "admin" });
    }
  }
  const port = Number(process.env.PORT || 8001);
  app.listen(port, "0.0.0.0", () => console.log(`API Wayire démarrée sur le port ${port}`));
}
if (require.main === module) start().catch((err) => {
  console.error("Impossible de démarrer le backend:", err.message);
  process.exitCode = 1;
});

module.exports = { app, start };
