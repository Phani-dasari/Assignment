const path = require("node:path");
const crypto = require("node:crypto");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const { createDatabase } = require("./db");

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PASSWORD_LENGTH = 128;
const MAX_SAFE_PRICE = 999999999;
const isUniqueConstraint = error =>
  error.code === "ERR_SQLITE_ERROR" && [1555, 2067].includes(error.errcode);

class SQLiteSessionStore extends session.Store {
  constructor(db, ttl = 1000 * 60 * 60 * 24 * 7) {
    super();
    this.db = db;
    this.ttl = ttl;
    this.getStatement = db.prepare("SELECT sess, expires FROM sessions WHERE sid = ?");
    this.setStatement = db.prepare(`
      INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires
    `);
    this.destroyStatement = db.prepare("DELETE FROM sessions WHERE sid = ?");
    this.touchStatement = db.prepare("UPDATE sessions SET expires = ? WHERE sid = ?");
    this.pruneStatement = db.prepare("DELETE FROM sessions WHERE expires <= ?");
  }

  get(sid, callback) {
    try {
      const row = this.getStatement.get(sid);
      if (!row) return callback(null, null);
      if (row.expires <= Date.now()) {
        this.destroyStatement.run(sid);
        return callback(null, null);
      }
      return callback(null, JSON.parse(row.sess));
    } catch (error) {
      return callback(error);
    }
  }

  set(sid, sess, callback = () => {}) {
    try {
      const expires = sess.cookie && sess.cookie.expires
        ? new Date(sess.cookie.expires).getTime()
        : Date.now() + this.ttl;
      this.setStatement.run(sid, JSON.stringify(sess), expires);
      this.pruneStatement.run(Date.now());
      return callback(null);
    } catch (error) {
      return callback(error);
    }
  }

  touch(sid, sess, callback = () => {}) {
    try {
      const expires = sess.cookie && sess.cookie.expires
        ? new Date(sess.cookie.expires).getTime()
        : Date.now() + this.ttl;
      this.touchStatement.run(expires, sid);
      return callback(null);
    } catch (error) {
      return callback(error);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      this.destroyStatement.run(sid);
      return callback(null);
    } catch (error) {
      return callback(error);
    }
  }
}

function createApp(options = {}) {
  const db = options.db || createDatabase(options.dbPath || process.env.DB_PATH);
  const app = express();
  const sessionSecret = options.sessionSecret || process.env.SESSION_SECRET;

  if (!sessionSecret && process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET must be set in production");
  }

  app.disable("x-powered-by");
  app.use(express.json({ limit: "20kb" }));
  app.use(session({
    name: "stockflow.sid",
    secret: sessionSecret || "development-only-stockflow-session-secret",
    resave: false,
    saveUninitialized: false,
    store: options.sessionStore || new SQLiteSessionStore(db),
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 7
    }
  }));
  app.use(express.static(path.join(__dirname, "public")));

  const sendError = (res, status, message) => res.status(status).json({ error: message });
  const requireCsrf = (req, res, next) => {
    const token = req.get("X-CSRF-Token");
    if (!req.session.csrfToken || token !== req.session.csrfToken) {
      return sendError(res, 403, "Your session expired. Refresh and try again.");
    }
    return next();
  };
  const requireAuth = (req, res, next) => {
    if (!req.session.userId || !req.session.organizationId) {
      return sendError(res, 401, "Please log in to continue.");
    }
    return next();
  };
  const validNonNegativeInteger = value =>
    Number.isSafeInteger(value) && value >= 0;
  const optionalPrice = value => {
    if (value === "" || value === null || value === undefined) return null;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_SAFE_PRICE) {
      return undefined;
    }
    return Math.round(value * 100) / 100;
  };
  const getProductInput = body => {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const sku = typeof body.sku === "string" ? body.sku.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const costPrice = optionalPrice(body.costPrice);
    const sellingPrice = optionalPrice(body.sellingPrice);
    const threshold = body.lowStockThreshold === "" || body.lowStockThreshold === null ||
      body.lowStockThreshold === undefined
      ? null
      : Number(body.lowStockThreshold);

    if (!name || name.length > 120) return { error: "Name is required and must be 120 characters or fewer." };
    if (!sku || sku.length > 80) return { error: "SKU is required and must be 80 characters or fewer." };
    if (description.length > 2000) return { error: "Description must be 2,000 characters or fewer." };
    if (!validNonNegativeInteger(body.quantityOnHand)) {
      return { error: "Quantity on hand must be a non-negative whole number." };
    }
    if (costPrice === undefined || sellingPrice === undefined) {
      return { error: "Prices must be valid non-negative numbers." };
    }
    if (threshold !== null && !validNonNegativeInteger(threshold)) {
      return { error: "Low stock threshold must be a non-negative whole number." };
    }
    return {
      value: {
        name, sku, description: description || null,
        quantityOnHand: body.quantityOnHand,
        costPrice, sellingPrice, lowStockThreshold: threshold
      }
    };
  };
  const productSelect = `
    SELECT p.id, p.name, p.sku, p.description, p.quantity_on_hand AS quantityOnHand,
      p.cost_price AS costPrice, p.selling_price AS sellingPrice,
      p.low_stock_threshold AS lowStockThreshold,
      COALESCE(p.low_stock_threshold, o.default_low_stock_threshold) AS effectiveLowStockThreshold,
      p.created_at AS createdAt, p.updated_at AS updatedAt
    FROM products p
    JOIN organizations o ON o.id = p.organization_id
  `;
  const insertProduct = db.prepare(`
    INSERT INTO products
      (organization_id, name, sku, description, quantity_on_hand, cost_price, selling_price, low_stock_threshold)
    VALUES (@organizationId, @name, @sku, @description, @quantityOnHand, @costPrice, @sellingPrice, @lowStockThreshold)
  `);

  app.get("/api/csrf", (req, res) => {
    if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString("hex");
    res.json({ token: req.session.csrfToken });
  });

  app.post("/api/signup", requireCsrf, async (req, res, next) => {
    try {
      const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
      const password = req.body.password;
      const organizationName = typeof req.body.organizationName === "string"
        ? req.body.organizationName.trim()
        : "";
      if (!EMAIL_PATTERN.test(email) || email.length > 254) {
        return sendError(res, 400, "Enter a valid email address.");
      }
      if (typeof password !== "string" || password.length < 8 || password.length > MAX_PASSWORD_LENGTH) {
        return sendError(res, 400, "Password must be between 8 and 128 characters.");
      }
      if (!organizationName || organizationName.length > 120) {
        return sendError(res, 400, "Organization name is required and must be 120 characters or fewer.");
      }
      const passwordHash = await bcrypt.hash(password, 12);
      const createAccount = db.transaction(() => {
        const organization = db.prepare("INSERT INTO organizations (name) VALUES (?)")
          .run(organizationName);
        const user = db.prepare(
          "INSERT INTO users (organization_id, email, password_hash) VALUES (?, ?, ?)"
        ).run(organization.lastInsertRowid, email, passwordHash);
        return { userId: user.lastInsertRowid, organizationId: organization.lastInsertRowid };
      });
      const account = createAccount();
      req.session.userId = account.userId;
      req.session.organizationId = account.organizationId;
      req.session.regenerate(err => {
        if (err) return next(err);
        req.session.userId = account.userId;
        req.session.organizationId = account.organizationId;
        req.session.csrfToken = crypto.randomBytes(32).toString("hex");
        req.session.save(saveError => {
          if (saveError) return next(saveError);
          return res.status(201).json({ user: getCurrentUser(account.userId) });
        });
      });
    } catch (error) {
      if (isUniqueConstraint(error)) {
        return sendError(res, 409, "An account with that email already exists.");
      }
      return next(error);
    }
  });

  function getCurrentUser(userId) {
    return db.prepare(`
      SELECT u.id, u.email, u.organization_id AS organizationId, o.name AS organizationName,
        o.default_low_stock_threshold AS defaultLowStockThreshold
      FROM users u JOIN organizations o ON o.id = u.organization_id
      WHERE u.id = ?
    `).get(userId);
  }

  app.post("/api/login", requireCsrf, (req, res, next) => {
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = req.body.password;
    const user = db.prepare("SELECT id, organization_id, password_hash FROM users WHERE email = ?")
      .get(email);
    const passwordHash = user ? user.password_hash : "$2a$12$invalidhashinvalidhashinvalidhashinvalidhashinvalidhashinvalid";
    bcrypt.compare(typeof password === "string" ? password : "", passwordHash)
      .then(matches => {
        if (!user || !matches) return sendError(res, 401, "Email or password is incorrect.");
        req.session.regenerate(err => {
          if (err) return next(err);
          req.session.userId = user.id;
          req.session.organizationId = user.organization_id;
          req.session.csrfToken = crypto.randomBytes(32).toString("hex");
          req.session.save(saveError => {
            if (saveError) return next(saveError);
            return res.json({ user: getCurrentUser(user.id) });
          });
        });
      })
      .catch(next);
  });

  app.post("/api/logout", requireCsrf, (req, res, next) => {
    req.session.destroy(error => {
      if (error) return next(error);
      res.clearCookie("stockflow.sid", {
        httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production"
      });
      return res.status(204).end();
    });
  });

  app.get("/api/me", requireAuth, (req, res) => {
    const user = getCurrentUser(req.session.userId);
    if (!user || user.organizationId !== req.session.organizationId) {
      return sendError(res, 401, "Please log in to continue.");
    }
    return res.json({ user });
  });

  app.get("/api/dashboard", requireAuth, (req, res) => {
    const organizationId = req.session.organizationId;
    const summary = db.prepare(`
      SELECT COUNT(*) AS totalProducts, COALESCE(SUM(quantity_on_hand), 0) AS totalUnits
      FROM products WHERE organization_id = ?
    `).get(organizationId);
    const lowStockCount = db.prepare(`
      SELECT COUNT(*) AS totalLowStock
      FROM products p
      JOIN organizations o ON o.id = p.organization_id
      WHERE p.organization_id = ?
        AND p.quantity_on_hand <= COALESCE(p.low_stock_threshold, o.default_low_stock_threshold)
    `).get(organizationId).totalLowStock;
    const lowStockItems = db.prepare(`
      ${productSelect}
      WHERE p.organization_id = ?
        AND p.quantity_on_hand <= COALESCE(p.low_stock_threshold, o.default_low_stock_threshold)
      ORDER BY p.quantity_on_hand ASC, p.name COLLATE NOCASE ASC
      LIMIT 10
    `).all(organizationId);
    return res.json({ ...summary, totalLowStock: lowStockCount, lowStockItems });
  });

  app.get("/api/products", requireAuth, (req, res) => {
    const query = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const products = db.prepare(`
      ${productSelect}
      WHERE p.organization_id = ?
        AND (? = '' OR p.name LIKE ? OR p.sku LIKE ?)
      ORDER BY p.name COLLATE NOCASE ASC
    `).all(req.session.organizationId, query, `%${query}%`, `%${query}%`);
    return res.json({ products });
  });

  app.post("/api/products", requireAuth, requireCsrf, (req, res) => {
    const parsed = getProductInput(req.body);
    if (parsed.error) return sendError(res, 400, parsed.error);
    try {
      const result = insertProduct.run({
        organizationId: req.session.organizationId,
        ...parsed.value
      });
      const product = db.prepare(`${productSelect} WHERE p.id = ? AND p.organization_id = ?`)
        .get(result.lastInsertRowid, req.session.organizationId);
      return res.status(201).json({ product });
    } catch (error) {
      if (isUniqueConstraint(error)) return sendError(res, 409, "That SKU already exists.");
      throw error;
    }
  });

  app.put("/api/products/:id", requireAuth, requireCsrf, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return sendError(res, 400, "Invalid product.");
    const parsed = getProductInput(req.body);
    if (parsed.error) return sendError(res, 400, parsed.error);
    try {
      const result = db.prepare(`
        UPDATE products
        SET name = @name, sku = @sku, description = @description,
          quantity_on_hand = @quantityOnHand, cost_price = @costPrice,
          selling_price = @sellingPrice, low_stock_threshold = @lowStockThreshold,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = @id AND organization_id = @organizationId
      `).run({ id, organizationId: req.session.organizationId, ...parsed.value });
      if (result.changes === 0) return sendError(res, 404, "Product not found.");
      const product = db.prepare(`${productSelect} WHERE p.id = ? AND p.organization_id = ?`)
        .get(id, req.session.organizationId);
      return res.json({ product });
    } catch (error) {
      if (isUniqueConstraint(error)) return sendError(res, 409, "That SKU already exists.");
      throw error;
    }
  });

  app.delete("/api/products/:id", requireAuth, requireCsrf, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return sendError(res, 400, "Invalid product.");
    const result = db.prepare("DELETE FROM products WHERE id = ? AND organization_id = ?")
      .run(id, req.session.organizationId);
    if (result.changes === 0) return sendError(res, 404, "Product not found.");
    return res.status(204).end();
  });

  app.put("/api/settings", requireAuth, requireCsrf, (req, res) => {
    const threshold = Number(req.body.defaultLowStockThreshold);
    if (!validNonNegativeInteger(threshold)) {
      return sendError(res, 400, "Default low stock threshold must be a non-negative whole number.");
    }
    db.prepare("UPDATE organizations SET default_low_stock_threshold = ? WHERE id = ?")
      .run(threshold, req.session.organizationId);
    return res.json({ defaultLowStockThreshold: threshold });
  });

  app.use((error, req, res, next) => {
    console.error(error);
    if (res.headersSent) return next(error);
    return sendError(res, 500, "Something went wrong. Please try again.");
  });

  return { app, db };
}

if (require.main === module) {
  const { app } = createApp();
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`StockFlow is running at http://localhost:${port}`));
}

module.exports = { createApp, SQLiteSessionStore };
