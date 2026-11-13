const authScreen = document.querySelector("#auth-screen");
const appShell = document.querySelector("#app-shell");
const authForm = document.querySelector("#auth-form");
const productDialog = document.querySelector("#product-dialog");
const productForm = document.querySelector("#product-form");
let csrfToken = "";
let currentUser = null;
let products = [];
let authMode = "login";
let activePage = "dashboard";
let toastTimer;

const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[char]);
const money = value => value == null
  ? "—"
  : new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(value);
const dateText = value => new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", year: "numeric" }).format(value);
const isLow = product => product.quantityOnHand <= product.effectiveLowStockThreshold;
const badge = product => isLow(product)
  ? '<span class="badge badge-low">Low stock</span>'
  : '<span class="badge">In stock</span>';

function notify(message, error = false) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
}

async function request(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers["Content-Type"] = "application/json";
  if (options.method && options.method !== "GET") headers["X-CSRF-Token"] = csrfToken;
  const response = await fetch(url, { ...options, headers });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

async function refreshCsrf() {
  const data = await request("/api/csrf");
  csrfToken = data.token;
}

function showAuth() {
  currentUser = null;
  appShell.classList.add("hidden");
  authScreen.classList.remove("hidden");
  setAuthMode("login");
}

function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === "signup";
  document.querySelector("#org-field").classList.toggle("hidden", !signup);
  document.querySelector("#confirm-field").classList.toggle("hidden", !signup);
  document.querySelector("#auth-eyebrow").textContent = signup ? "GET STARTED" : "WELCOME BACK";
  document.querySelector("#auth-title").textContent = signup ? "Make room to grow." : "Good to see you.";
  document.querySelector("#auth-copy").textContent = signup
    ? "Create your workspace and take stock."
    : "Sign in to your inventory workspace.";
  document.querySelector("#auth-submit").innerHTML = signup ? 'Create workspace <span>→</span>' : 'Sign in <span>→</span>';
  document.querySelector("#auth-switch-copy").textContent = signup ? "Already have an account?" : "New to StockFlow?";
  document.querySelector("#auth-switch").textContent = signup ? "Sign in" : "Create an account";
  authForm.elements.password.autocomplete = signup ? "new-password" : "current-password";
  authForm.elements.confirmPassword.required = signup;
  authForm.reset();
}

function showApp(user) {
  currentUser = user;
  authScreen.classList.add("hidden");
  appShell.classList.remove("hidden");
  document.querySelector("#profile-email").textContent = user.email;
  document.querySelector("#profile-org").textContent = user.organizationName;
  document.querySelector("#avatar").textContent = user.organizationName.charAt(0).toUpperCase();
  document.querySelector("#today-label").textContent = dateText(new Date());
  navigate("dashboard");
}

async function boot() {
  await refreshCsrf();
  try {
    const data = await request("/api/me");
    showApp(data.user);
  } catch (error) {
    if (error.message !== "Please log in to continue.") notify(error.message, true);
    showAuth();
  }
}

function navigate(page) {
  activePage = page;
  document.querySelectorAll(".page").forEach(section => section.classList.add("hidden"));
  document.querySelector(`#page-${page}`).classList.remove("hidden");
  document.querySelectorAll("[data-page]").forEach(button => button.classList.toggle("active", button.dataset.page === page));
  document.querySelector("#breadcrumb-current").textContent = page === "dashboard" ? "Overview" : page[0].toUpperCase() + page.slice(1);
  if (page === "dashboard") renderDashboard();
  if (page === "products") loadProducts();
  if (page === "settings") renderSettings();
}

function renderDashboard() {
  const page = document.querySelector("#page-dashboard");
  page.innerHTML = `
    <div class="page-heading">
      <div><div class="eyebrow">YOUR BUSINESS AT A GLANCE</div><h1>Overview</h1><p>Here’s what’s happening with your inventory today.</p></div>
      <button class="button button-primary" data-add-product type="button">Add product <span>→</span></button>
    </div>
    <div class="stats-grid">
      <article class="stat-card"><span class="stat-label">Total products</span><strong class="stat-value" id="stat-products">—</strong></article>
      <article class="stat-card"><span class="stat-label">Units in stock</span><strong class="stat-value" id="stat-units">—</strong></article>
      <article class="stat-card"><span class="stat-label">Need attention</span><strong class="stat-value" id="stat-low">—<span class="stat-hint">low stock</span></strong></article>
    </div>
    <section class="panel">
      <div class="panel-header"><div><h2>Low stock items</h2><p>Products at or below their stock threshold.</p></div><button class="subtle-link" data-page="products" type="button">All products →</button></div>
      <div id="low-stock-table"><div class="empty-state"><p>Loading inventory…</p></div></div>
    </section>`;
  page.querySelectorAll("[data-add-product]").forEach(button => button.addEventListener("click", () => openProductForm()));
  page.querySelectorAll('[data-page="products"]').forEach(button => button.addEventListener("click", () => navigate("products")));
  request("/api/dashboard").then(data => {
    document.querySelector("#stat-products").textContent = data.totalProducts.toLocaleString();
    document.querySelector("#stat-units").textContent = data.totalUnits.toLocaleString();
    document.querySelector("#stat-low").innerHTML = `${data.totalLowStock}<span class="stat-hint">low stock</span>`;
    document.querySelector("#low-stock-table").innerHTML = data.lowStockItems.length
      ? productTable(data.lowStockItems, true)
      : `<div class="empty-state"><div class="empty-mark">✓</div><strong>All stocked up</strong><p>No products are currently below their threshold.</p><button class="button button-quiet" data-page="products" type="button">View products</button></div>`;
    document.querySelector("#low-stock-table").querySelectorAll('[data-page="products"]').forEach(button => button.addEventListener("click", () => navigate("products")));
  }).catch(error => notify(error.message, true));
}

function productTable(items, dashboard = false) {
  if (!items.length) return `<div class="empty-state"><strong>No products yet</strong><p>Add your first product to start tracking inventory.</p><button class="button button-primary" data-add-product type="button">Add product</button></div>`;
  return `<div class="table-wrap"><table>
    <thead><tr><th>Product</th><th>SKU</th><th>Quantity</th><th>Status</th><th>Selling price</th>${dashboard ? "" : "<th></th>"}</tr></thead>
    <tbody>${items.map(product => `<tr>
      <td><span class="product-name">${escapeHtml(product.name)}</span>${product.description ? `<span class="product-sku">${escapeHtml(product.description)}</span>` : ""}</td>
      <td>${escapeHtml(product.sku)}</td>
      <td>${product.quantityOnHand.toLocaleString()} <span class="muted">/ ${product.effectiveLowStockThreshold} min</span></td>
      <td>${badge(product)}</td>
      <td>${money(product.sellingPrice)}</td>
      ${dashboard ? "" : `<td><div class="row-actions"><button class="row-action" data-edit="${product.id}" type="button">Edit</button><button class="row-action delete" data-delete="${product.id}" type="button">Delete</button></div></td>`}
    </tr>`).join("")}</tbody>
  </table></div>`;
}

async function loadProducts(search = "") {
  const page = document.querySelector("#page-products");
  page.innerHTML = `
    <div class="page-heading">
      <div><div class="eyebrow">YOUR CATALOG</div><h1>Products</h1><p>Manage your products, prices, and stock levels.</p></div>
      <div class="toolbar"><label class="search-box"><span>⌕</span><input id="product-search" aria-label="Search products" placeholder="Search name or SKU" value="${escapeHtml(search)}"></label><button class="button button-primary" data-add-product type="button">Add product <span>→</span></button></div>
    </div>
    <section class="panel"><div class="panel-header"><div><h2>All products</h2><p id="product-count">Loading your catalog…</p></div></div><div id="products-table"></div></section>`;
  page.querySelector("[data-add-product]").addEventListener("click", () => openProductForm());
  const searchInput = page.querySelector("#product-search");
  let searchTimer;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadProducts(searchInput.value), 180);
  });
  try {
    const data = await request(`/api/products?search=${encodeURIComponent(search)}`);
    products = data.products;
    if (activePage !== "products") return;
    page.querySelector("#product-count").textContent = `${data.products.length} ${data.products.length === 1 ? "product" : "products"} in your catalog`;
    page.querySelector("#products-table").innerHTML = productTable(data.products);
    document.querySelector("#nav-count").textContent = String(data.products.length);
    page.querySelectorAll("[data-edit]").forEach(button => button.addEventListener("click", () => {
      const product = products.find(item => item.id === Number(button.dataset.edit));
      if (product) openProductForm(product);
    }));
    page.querySelectorAll("[data-delete]").forEach(button => button.addEventListener("click", () => deleteProduct(Number(button.dataset.delete))));
    page.querySelectorAll("[data-add-product]").forEach(button => button.addEventListener("click", () => openProductForm()));
  } catch (error) {
    notify(error.message, true);
  }
}

function openProductForm(product = null) {
  productForm.reset();
  productForm.elements.id.value = product ? product.id : "";
  document.querySelector("#product-dialog-title").textContent = product ? "Edit product" : "Add a product";
  if (product) {
    for (const key of ["name", "sku", "description", "quantityOnHand", "lowStockThreshold"]) {
      productForm.elements[key].value = product[key] ?? "";
    }
    productForm.elements.costPrice.value = product.costPrice ?? "";
    productForm.elements.sellingPrice.value = product.sellingPrice ?? "";
  } else {
    productForm.elements.quantityOnHand.value = "0";
  }
  productDialog.showModal();
}

async function deleteProduct(id) {
  const product = products.find(item => item.id === id);
  if (!product || !confirm(`Delete “${product.name}”? This cannot be undone.`)) return;
  try {
    await request(`/api/products/${id}`, { method: "DELETE" });
    notify("Product deleted.");
    await loadProducts(document.querySelector("#product-search")?.value || "");
    if (activePage === "dashboard") renderDashboard();
  } catch (error) {
    notify(error.message, true);
  }
}

function renderSettings() {
  document.querySelector("#page-settings").innerHTML = `
    <div class="page-heading"><div><div class="eyebrow">MAKE IT YOURS</div><h1>Settings</h1><p>Adjust defaults for your workspace.</p></div></div>
    <section class="settings-card">
      <h2>Inventory defaults</h2><p>Set the default threshold used to flag products as low stock. A product-specific threshold overrides this value.</p>
      <form id="settings-form" class="settings-field">
        <label class="field">Default low stock threshold
          <input name="defaultLowStockThreshold" type="number" min="0" step="1" required value="${currentUser.defaultLowStockThreshold}">
        </label>
        <button class="button button-primary" type="submit">Save changes</button>
      </form>
      <div class="settings-note">Products with no custom threshold use this setting. Items with quantity at or below the threshold appear in your low stock list.</div>
    </section>`;
  document.querySelector("#settings-form").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const data = await request("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ defaultLowStockThreshold: Number(form.elements.defaultLowStockThreshold.value) })
      });
      currentUser.defaultLowStockThreshold = data.defaultLowStockThreshold;
      notify("Settings saved.");
    } catch (error) {
      notify(error.message, true);
    }
  });
}

authForm.addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  if (authMode === "signup" && form.elements.password.value !== form.elements.confirmPassword.value) {
    notify("Passwords do not match.", true);
    return;
  }
  const payload = {
    email: form.elements.email.value,
    password: form.elements.password.value
  };
  if (authMode === "signup") payload.organizationName = form.elements.organizationName.value;
  try {
    const data = await request(`/api/${authMode}`, { method: "POST", body: JSON.stringify(payload) });
    await refreshCsrf();
    showApp(data.user);
    notify(authMode === "signup" ? "Your workspace is ready." : "Welcome back.");
  } catch (error) {
    notify(error.message, true);
  }
});

document.querySelector("#auth-switch").addEventListener("click", () => setAuthMode(authMode === "login" ? "signup" : "login"));
document.querySelectorAll(".nav-link, .brand[data-page]").forEach(button => {
  button.addEventListener("click", () => navigate(button.dataset.page));
});
document.querySelector("#logout").addEventListener("click", async () => {
  try {
    await request("/api/logout", { method: "POST" });
    await refreshCsrf();
    showAuth();
    notify("You’ve been signed out.");
  } catch (error) {
    notify(error.message, true);
  }
});
document.querySelectorAll("[data-close-dialog]").forEach(button => button.addEventListener("click", () => productDialog.close()));
productDialog.addEventListener("click", event => {
  if (event.target === productDialog) productDialog.close();
});
productForm.addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.elements.id.value;
  const payload = {
    name: form.elements.name.value,
    sku: form.elements.sku.value,
    description: form.elements.description.value,
    quantityOnHand: Number(form.elements.quantityOnHand.value),
    costPrice: form.elements.costPrice.value === "" ? null : Number(form.elements.costPrice.value),
    sellingPrice: form.elements.sellingPrice.value === "" ? null : Number(form.elements.sellingPrice.value),
    lowStockThreshold: form.elements.lowStockThreshold.value === "" ? null : Number(form.elements.lowStockThreshold.value)
  };
  try {
    await request(id ? `/api/products/${id}` : "/api/products", {
      method: id ? "PUT" : "POST", body: JSON.stringify(payload)
    });
    productDialog.close();
    notify(id ? "Product updated." : "Product added.");
    if (activePage === "products") await loadProducts(document.querySelector("#product-search")?.value || "");
    if (activePage === "dashboard") renderDashboard();
  } catch (error) {
    notify(error.message, true);
  }
});

boot().catch(error => {
  showAuth();
  notify(error.message, true);
});
