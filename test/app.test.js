const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const session = require("express-session");
const { createApp } = require("../server");
const { createDatabase } = require("../db");

function createHarness() {
  const db = createDatabase(":memory:");
  const { app } = createApp({
    db,
    sessionSecret: "test-session-secret",
    sessionStore: new session.MemoryStore()
  });
  return { app, db };
}

async function signup(app, email, organizationName) {
  const agent = request.agent(app);
  const csrf = await agent.get("/api/csrf");
  const result = await agent.post("/api/signup")
    .set("X-CSRF-Token", csrf.body.token)
    .send({ email, password: "correct horse battery staple", organizationName });
  return { agent, result };
}

test("signup creates a tenant and login protects the dashboard", async t => {
  const { app, db } = createHarness();
  t.after(() => db.close());
  const { agent, result } = await signup(app, "owner@example.com", "Northwind Goods");
  assert.equal(result.status, 201);
  assert.equal(result.body.user.organizationName, "Northwind Goods");
  assert.equal((await agent.get("/api/dashboard")).status, 200);

  const secondSession = request.agent(app);
  assert.equal((await secondSession.get("/api/dashboard")).status, 401);
  const csrf = await secondSession.get("/api/csrf");
  const login = await secondSession.post("/api/login")
    .set("X-CSRF-Token", csrf.body.token)
    .send({ email: "owner@example.com", password: "correct horse battery staple" });
  assert.equal(login.status, 200);
  assert.equal((await secondSession.get("/api/me")).body.user.email, "owner@example.com");
});

test("product CRUD enforces per-organization SKU uniqueness and tenant isolation", async t => {
  const { app, db } = createHarness();
  t.after(() => db.close());
  const first = await signup(app, "one@example.com", "One");
  const second = await signup(app, "two@example.com", "Two");

  const firstCsrf = await first.agent.get("/api/csrf");
  const productBody = {
    name: "Canvas Tote", sku: "TOTE-1", quantityOnHand: 3,
    costPrice: 4.5, sellingPrice: 12, lowStockThreshold: null
  };
  const created = await first.agent.post("/api/products")
    .set("X-CSRF-Token", firstCsrf.body.token).send(productBody);
  assert.equal(created.status, 201);
  assert.equal(created.body.product.effectiveLowStockThreshold, 5);

  const duplicate = await first.agent.post("/api/products")
    .set("X-CSRF-Token", firstCsrf.body.token).send(productBody);
  assert.equal(duplicate.status, 409);

  const secondCsrf = await second.agent.get("/api/csrf");
  const sameSkuOtherOrg = await second.agent.post("/api/products")
    .set("X-CSRF-Token", secondCsrf.body.token).send(productBody);
  assert.equal(sameSkuOtherOrg.status, 201);

  const crossTenantUpdate = await second.agent.put(`/api/products/${created.body.product.id}`)
    .set("X-CSRF-Token", secondCsrf.body.token).send({ ...productBody, quantityOnHand: 99 });
  assert.equal(crossTenantUpdate.status, 404);
  const crossTenantDelete = await second.agent.delete(`/api/products/${created.body.product.id}`)
    .set("X-CSRF-Token", secondCsrf.body.token);
  assert.equal(crossTenantDelete.status, 404);
  assert.equal((await first.agent.get("/api/products")).body.products[0].quantityOnHand, 3);
  const summary = await first.agent.get("/api/dashboard");
  assert.equal(summary.body.totalProducts, 1);
  assert.equal(summary.body.totalUnits, 3);
  assert.equal(summary.body.totalLowStock, 1);
  assert.equal(summary.body.lowStockItems.length, 1);

  const updated = await first.agent.put(`/api/products/${created.body.product.id}`)
    .set("X-CSRF-Token", firstCsrf.body.token)
    .send({ ...productBody, quantityOnHand: 9 });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.product.quantityOnHand, 9);
  assert.equal((await first.agent.get("/api/dashboard")).body.lowStockItems.length, 0);

  const deleted = await first.agent.delete(`/api/products/${created.body.product.id}`)
    .set("X-CSRF-Token", firstCsrf.body.token);
  assert.equal(deleted.status, 204);
  assert.equal((await first.agent.get("/api/products")).body.products.length, 0);
});

test("product validation and organization low-stock defaults are enforced", async t => {
  const { app, db } = createHarness();
  t.after(() => db.close());
  const { agent } = await signup(app, "settings@example.com", "Settings");
  const csrf = await agent.get("/api/csrf");
  const invalid = await agent.post("/api/products").set("X-CSRF-Token", csrf.body.token).send({
    name: "Bad quantity", sku: "BAD-1", quantityOnHand: -1
  });
  assert.equal(invalid.status, 400);

  const updatedSettings = await agent.put("/api/settings")
    .set("X-CSRF-Token", csrf.body.token)
    .send({ defaultLowStockThreshold: 2 });
  assert.equal(updatedSettings.status, 200);
  const created = await agent.post("/api/products").set("X-CSRF-Token", csrf.body.token).send({
    name: "Notebook", sku: "NOTE-1", quantityOnHand: 3,
    costPrice: null, sellingPrice: null, lowStockThreshold: null
  });
  assert.equal(created.body.product.effectiveLowStockThreshold, 2);
  assert.equal((await agent.get("/api/dashboard")).body.lowStockItems.length, 0);
});

test("state-changing requests require a CSRF token and login rejects bad credentials", async t => {
  const { app, db } = createHarness();
  t.after(() => db.close());
  const { agent } = await signup(app, "csrf@example.com", "CSRF");
  assert.equal((await agent.post("/api/logout")).status, 403);
  const csrf = await agent.get("/api/csrf");
  const badLogin = await agent.post("/api/login")
    .set("X-CSRF-Token", csrf.body.token)
    .send({ email: "csrf@example.com", password: "wrong password" });
  assert.equal(badLogin.status, 401);
});
