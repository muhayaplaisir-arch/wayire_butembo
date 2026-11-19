const mongoose = require("mongoose");
const { randomUUID } = require("node:crypto");

const options = { versionKey: false, toJSON: { virtuals: false, transform: (_, value) => { delete value._id; return value; } } };
const id = { type: String, default: () => randomUUID(), unique: true, required: true };
const created_at = { type: Date, default: Date.now };

function model(name, fields) {
  return mongoose.model(name, new mongoose.Schema({ id, ...fields }, options));
}

const User = model("User", {
  email: { type: String, required: true, unique: true, lowercase: true },
  name: { type: String, required: true },
  password_hash: { type: String, required: true, select: false },
  role: { type: String, default: "user" }, created_at,
});
const Product = model("Product", {
  name: { type: String, required: true }, sku: { type: String, default: "" },
  category: { type: String, default: "" }, price: { type: Number, required: true },
  cost: { type: Number, default: 0 }, stock: { type: Number, default: 0 },
  low_stock_threshold: { type: Number, default: 5 }, created_at,
});
const itemSchema = new mongoose.Schema({
  product_id: { type: String, required: true }, name: { type: String, required: true },
  price: { type: Number, required: true }, qty: { type: Number, required: true },
}, { _id: false });
const Invoice = model("Invoice", {
  number: { type: String, required: true, unique: true },
  customer_name: { type: String, default: "" }, customer_phone: { type: String, default: "" },
  items: [itemSchema], subtotal: Number, discount: Number, total: Number, paid_amount: Number,
  balance: Number, status: String, payment_method: String, operator_name: String,
  deposit_id: { type: String, default: null }, deposit_amount: { type: Number, default: 0 },
  user_id: String, created_at,
});
const Movement = model("StockMovement", { product_id: String, qty: Number, reason: String, user_id: String, created_at });
const Payment = model("CreditPayment", { invoice_id: String, amount: Number, note: String, user_id: String, created_at });
const Deposit = model("Deposit", {
  customer_name: String, customer_phone: { type: String, default: "" }, product_name: String,
  amount: Number, remaining: Number, note: { type: String, default: "" }, user_id: String, created_at,
});
const Expense = model("Expense", {
  description: String, amount: Number, debt: Number, paid_cash: Number, user_id: String, created_at,
});
const CashEntry = model("CashEntry", {
  destination: { type: String, required: true }, reason: { type: String, required: true },
  amount: { type: Number, required: true }, date: { type: String, required: true },
  user_id: { type: String, required: true }, user_name: { type: String, required: true }, created_at,
});
const Settings = model("ShopSettings", {
  shop_name: { type: String, default: "Wayire | Mel | Butembo" },
  shop_address: { type: String, default: "" }, shop_phone: { type: String, default: "" },
  credit_limit: { type: Number, default: 10000 }, cash_balance: { type: Number, default: 0 },
});

module.exports = { User, Product, Invoice, Movement, Payment, Deposit, Expense, CashEntry, Settings };
