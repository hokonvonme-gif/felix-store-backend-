/**
 * Félix Store Backend v2
 * Catalogue, panier, Stripe Checkout, commandes, admin
 */
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const { PRODUCTS, CATEGORIES } = require('./products-data');

// ==================== CONFIG ====================
const ENV = {
  EMAIL_USER: process.env.EMAIL_USER || '',
  EMAIL_PASSWORD: process.env.EMAIL_PASSWORD || '',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'admin123',
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || 'sk_test_...',
  STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY || 'pk_test_...',
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || 'whsec_...',
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  // URL publique de ton frontend (ou de ce backend si même domaine)
  FRONTEND_URL: process.env.FRONTEND_URL || process.env.BASE_URL || 'http://localhost:3000',
  BASE_URL: process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
  // Analytics (optionnel : Google Analytics Measurement Protocol)
  GA_MEASUREMENT_ID: process.env.GA_MEASUREMENT_ID || '', // ex: G-XXXXXXXX
  GA_API_SECRET: process.env.GA_API_SECRET || '',
  // Supabase = catalogue produits (source de vérité si configuré)
  SUPABASE_URL: process.env.SUPABASE_URL || '',
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || ''
};

const stripe = require('stripe')(ENV.STRIPE_SECRET_KEY);

// Client Supabase (catalogue)
let supabase = null;
if (ENV.SUPABASE_URL && ENV.SUPABASE_SERVICE_ROLE_KEY) {
  try {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(ENV.SUPABASE_URL, ENV.SUPABASE_SERVICE_ROLE_KEY);
    console.log('Supabase: catalogue connecté');
  } catch (e) {
    console.warn('Supabase non chargé:', e.message);
  }
}

function mapSupabaseProduct(row) {
  if (!row) return null;
  const images = Array.isArray(row.images) ? row.images : (row.images ? [row.images] : []);
  return {
    id: Number(row.id),
    name: row.name,
    description: row.description || '',
    price: Number(row.price),
    originalPrice: row.original_price != null ? Number(row.original_price) : null,
    category: row.category_id || row.category,
    stock: row.stock != null ? Number(row.stock) : 0,
    images,
    image: images[0] || '',
    rating: row.rating != null ? Number(row.rating) : 0,
    reviewCount: row.review_count != null ? Number(row.review_count) : 0,
    featured: !!row.featured,
    badge: row.badge || null,
    tags: Array.isArray(row.tags) ? row.tags : [],
    specifications: row.specifications && typeof row.specifications === 'object' ? row.specifications : {}
  };
}

const app = express();

// ==================== MIDDLEWARE ====================
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

// Webhook Stripe doit recevoir le body brut
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(bodyParser.json({ limit: '2mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// ==================== DATABASE ====================
const dbPath = ENV.NODE_ENV === 'production' ? '/tmp/felix-store.db' : path.join(__dirname, 'felix-store.db');

if (dbPath.startsWith('/tmp') && !fs.existsSync('/tmp')) {
  try { fs.mkdirSync('/tmp', { recursive: true }); } catch (_) {}
}

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('DB error:', err.message);
    process.exit(1);
  }
  console.log('SQLite connected:', dbPath);
  initDatabase();
});

function initDatabase() {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      price REAL NOT NULL,
      originalPrice REAL,
      category TEXT NOT NULL,
      stock INTEGER DEFAULT 0,
      image TEXT,
      images TEXT,
      rating REAL DEFAULT 0,
      reviewCount INTEGER DEFAULT 0,
      featured INTEGER DEFAULT 0,
      badge TEXT,
      tags TEXT,
      specifications TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT UNIQUE NOT NULL,
      customer_email TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      customer_phone TEXT,
      customer_address TEXT,
      total_amount REAL NOT NULL,
      status TEXT DEFAULT 'pending_payment',
      payment_status TEXT DEFAULT 'pending',
      stripe_session_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      product_name TEXT,
      product_category TEXT,
      quantity INTEGER NOT NULL,
      unit_price REAL NOT NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id)
    )`);
    // Migration douce si la colonne n'existait pas
    db.run(`ALTER TABLE order_items ADD COLUMN product_category TEXT`, () => {});

    db.run(`CREATE TABLE IF NOT EXISTS subscribers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nom TEXT NOT NULL,
      prenom TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      lieu TEXT,
      profession TEXT,
      pays TEXT,
      ville TEXT,
      date_naissance TEXT,
      date_inscription DATETIME DEFAULT CURRENT_TIMESTAMP,
      statut TEXT DEFAULT 'actif'
    )`);

    // Comptes clients (frontend Mon compte → backend)
    db.run(`CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nom TEXT NOT NULL,
      prenom TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      date_naissance TEXT,
      lieu TEXT,
      profession TEXT,
      pays TEXT,
      ville TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login DATETIME
    )`);

    // Analytics (backend only)
    db.run(`CREATE TABLE IF NOT EXISTS analytics_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      session_id TEXT,
      path TEXT,
      product_id INTEGER,
      meta TEXT,
      ip_hash TEXT,
      user_agent TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_ae_type ON analytics_events(event_type)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_ae_session ON analytics_events(session_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_ae_created ON analytics_events(created_at)`);

    db.run(`CREATE TABLE IF NOT EXISTS analytics_sessions (
      session_id TEXT PRIMARY KEY,
      first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
      page_views INTEGER DEFAULT 0,
      ip_hash TEXT,
      user_agent TEXT
    )`);

    seedProducts();
  });
}

function seedProducts() {
  db.get('SELECT COUNT(*) as count FROM products', (err, row) => {
    if (err) return console.error(err);
    if (row.count > 0) {
      console.log(`${row.count} produits déjà en base`);
      return;
    }
    const stmt = db.prepare(`INSERT INTO products
      (id, name, description, price, originalPrice, category, stock, image, images, rating, reviewCount, featured, badge, tags, specifications)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    PRODUCTS.forEach(p => {
      const mainImage = (p.images && p.images[0]) || '';
      stmt.run(
        p.id,
        p.name,
        p.description,
        p.price,
        p.originalPrice || null,
        p.category,
        p.stock,
        mainImage,
        JSON.stringify(p.images || []),
        p.rating || 0,
        p.reviewCount || 0,
        p.featured ? 1 : 0,
        p.badge || null,
        JSON.stringify(p.tags || []),
        JSON.stringify(p.specifications || {})
      );
    });
    stmt.finalize(() => console.log(`${PRODUCTS.length} produits insérés`));
  });
}

function generateOrderNumber() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `FS-${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${Date.now().toString(36).toUpperCase()}`;
}

// ==================== ANALYTICS (backend) ====================
const crypto = require('crypto');

function hashIp(ip) {
  if (!ip) return null;
  return crypto.createHash('sha256').update(String(ip) + 'felix-salt').digest('hex').slice(0, 16);
}

function getClientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.socket?.remoteAddress || req.ip || '';
}

function ensureSessionId(req, res) {
  let sid = req.headers['x-session-id'] || req.query.sid;
  if (!sid || typeof sid !== 'string' || sid.length < 8) {
    sid = crypto.randomBytes(16).toString('hex');
  }
  res.setHeader('X-Session-Id', sid);
  return sid.slice(0, 64);
}

function trackEvent(eventType, { sessionId, path, productId, meta, ip, userAgent } = {}) {
  const ipHash = hashIp(ip);
  const ua = (userAgent || '').slice(0, 300);
  const metaStr = meta ? JSON.stringify(meta) : null;

  // Supabase (permanent)
  if (supabase) {
    supabase.from('analytics_events').insert({
      event_type: eventType,
      session_id: sessionId || null,
      path: path || null,
      product_id: productId || null,
      meta: meta || null,
      ip_hash: ipHash,
      user_agent: ua
    }).then(({ error }) => { if (error) console.warn('analytics sb', error.message); }).catch(() => {});

    if (sessionId) {
      (async () => {
        try {
          const { data: existing } = await supabase
            .from('analytics_sessions')
            .select('session_id, page_views')
            .eq('session_id', sessionId)
            .maybeSingle();
          if (!existing) {
            await supabase.from('analytics_sessions').insert({
              session_id: sessionId,
              page_views: eventType === 'page_view' ? 1 : 0,
              ip_hash: ipHash,
              user_agent: ua
            });
          } else {
            await supabase.from('analytics_sessions').update({
              last_seen: new Date().toISOString(),
              page_views: (existing.page_views || 0) + (eventType === 'page_view' ? 1 : 0)
            }).eq('session_id', sessionId);
          }
        } catch (_) {}
      })();
    }
  } else {
    // SQLite secours
    db.run(
      `INSERT INTO analytics_events (event_type, session_id, path, product_id, meta, ip_hash, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [eventType, sessionId || null, path || null, productId || null, metaStr, ipHash, ua],
      (err) => { if (err) console.error('analytics insert', err.message); }
    );
    if (sessionId) {
      db.run(
        `INSERT INTO analytics_sessions (session_id, first_seen, last_seen, page_views, ip_hash, user_agent)
         VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           last_seen = CURRENT_TIMESTAMP,
           page_views = page_views + CASE WHEN ? = 'page_view' THEN 1 ELSE 0 END`,
        [sessionId, eventType === 'page_view' ? 1 : 0, ipHash, ua, eventType],
        () => {}
      );
    }
  }

  if (ENV.GA_MEASUREMENT_ID && ENV.GA_API_SECRET) {
    sendToGA4(eventType, { sessionId, path, productId, meta }).catch(() => {});
  }
}

async function sendToGA4(eventName, { sessionId, path, productId, meta } = {}) {
  try {
    const url = `https://www.google-analytics.com/mp/collect?measurement_id=${ENV.GA_MEASUREMENT_ID}&api_secret=${ENV.GA_API_SECRET}`;
    const body = {
      client_id: sessionId || crypto.randomBytes(8).toString('hex'),
      events: [{
        name: String(eventName).replace(/[^a-z0-9_]/gi, '_').slice(0, 40),
        params: {
          page_location: path || undefined,
          product_id: productId || undefined,
          ...(meta && typeof meta === 'object' ? meta : {})
        }
      }]
    };
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) {
    console.warn('GA4 MP error', e.message);
  }
}

// Middleware : enregistre les hits API comme page_view / visit (côté serveur)
app.use((req, res, next) => {
  // Ne pas logger les assets / health trop bruyants
  if (req.path === '/api/health' || req.path === '/api/analytics/stats') return next();
  if (req.method === 'OPTIONS') return next();

  const sid = ensureSessionId(req, res);
  const ip = getClientIp(req);
  const ua = req.headers['user-agent'] || '';

  // Nouvelle session ≈ première fois qu’on voit ce session_id
  db.get('SELECT session_id FROM analytics_sessions WHERE session_id = ?', [sid], (err, row) => {
    if (!err && !row) {
      trackEvent('visit', { sessionId: sid, path: req.path, ip, userAgent: ua });
    }
  });

  // page_view pour les routes “page-like”
  if (req.method === 'GET' && (req.path === '/' || req.path.startsWith('/api/products'))) {
    trackEvent('page_view', { sessionId: sid, path: req.path, ip, userAgent: ua });
  }

  req.analyticsSessionId = sid;
  next();
});

function createTransporter() {
  if (!ENV.EMAIL_USER || !ENV.EMAIL_PASSWORD) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: ENV.EMAIL_USER, pass: ENV.EMAIL_PASSWORD }
  });
}

// Transporteur dédié à la newsletter, avec la même config SMTP explicite que le sketch
// ESP32 (smtp.gmail.com:587 + STARTTLS) au lieu du raccourci "service: 'gmail'" ci-dessus,
// qui pousse nodemailer à choisir le port 465 (TLS implicite) — souvent filtré ou plus
// facilement flaggé par Gmail depuis une IP d'hébergeur comme celles de Render.
function createBroadcastTransporter() {
  if (!ENV.EMAIL_USER || !ENV.EMAIL_PASSWORD) return null;
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,      // false = STARTTLS sur le port 587 (pas de TLS implicite)
    requireTLS: true,
    auth: { user: ENV.EMAIL_USER, pass: ENV.EMAIL_PASSWORD }
  });
}

// ==================== ROUTES PUBLIQUES ====================

app.get('/', (req, res) => {
  res.json({
    name: 'Félix Store API',
    version: '2.0.0',
    status: 'online',
    endpoints: {
      products: 'GET /api/products',
      product: 'GET /api/products/:id',
      categories: 'GET /api/categories',
      checkout: 'POST /api/create-checkout-session',
      webhook: 'POST /api/webhook',
      orders: 'GET /api/orders?password=...',
      admin: 'GET /admin'
    }
  });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Catalogue complet (Supabase si configuré, sinon SQLite)
app.get('/api/products', async (req, res) => {
  const { category, q, featured, limit } = req.query;

  if (supabase) {
    try {
      let query = supabase.from('products').select('*').eq('active', true);
      if (category && category !== 'all') query = query.eq('category_id', category);
      if (featured === '1' || featured === 'true') query = query.eq('featured', true);
      if (q) query = query.or(`name.ilike.%${q}%,description.ilike.%${q}%`);
      query = query.order('featured', { ascending: false }).order('name', { ascending: true });
      if (limit) query = query.limit(parseInt(limit, 10));
      const { data, error } = await query;
      if (error) return res.status(500).json({ success: false, message: error.message });
      const products = (data || []).map(mapSupabaseProduct);
      // Table Supabase vide → garder les 80 produits SQLite en secours
      if (products.length > 0) {
        return res.json({ success: true, source: 'supabase', count: products.length, products });
      }
      console.warn('Supabase products vide → fallback SQLite (80 produits)');
    } catch (e) {
      console.warn('Supabase error → fallback SQLite', e.message);
    }
  }

  let sql = 'SELECT * FROM products WHERE 1=1';
  const params = [];
  if (category && category !== 'all') {
    sql += ' AND category = ?';
    params.push(category);
  }
  if (featured === '1' || featured === 'true') sql += ' AND featured = 1';
  if (q) {
    sql += ' AND (name LIKE ? OR description LIKE ? OR tags LIKE ?)';
    const term = `%${q}%`;
    params.push(term, term, term);
  }
  sql += ' ORDER BY featured DESC, rating DESC, name ASC';
  if (limit) {
    sql += ' LIMIT ?';
    params.push(parseInt(limit, 10));
  }
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    const products = (rows || []).map(row => ({
      id: row.id,
      name: row.name,
      description: row.description,
      price: row.price,
      originalPrice: row.originalPrice,
      category: row.category,
      stock: row.stock,
      images: safeJson(row.images, row.image ? [row.image] : []),
      rating: row.rating,
      reviewCount: row.reviewCount,
      featured: !!row.featured,
      badge: row.badge,
      tags: safeJson(row.tags, []),
      specifications: safeJson(row.specifications, {})
    }));
    res.json({ success: true, source: 'sqlite', count: products.length, products });
  });
});

app.get('/api/products/:id', async (req, res) => {
  const sid = req.analyticsSessionId || ensureSessionId(req, res);
  const productId = parseInt(req.params.id, 10) || null;
  trackEvent('product_view', {
    sessionId: sid,
    path: req.path,
    productId,
    ip: getClientIp(req),
    userAgent: req.headers['user-agent']
  });

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('products')
        .select('*')
        .eq('id', productId)
        .eq('active', true)
        .maybeSingle();
      if (error) return res.status(500).json({ success: false, message: error.message });
      if (!data) return res.status(404).json({ success: false, message: 'Produit introuvable' });
      return res.json({ success: true, source: 'supabase', product: mapSupabaseProduct(data) });
    } catch (e) {
      return res.status(500).json({ success: false, message: e.message });
    }
  }

  db.get('SELECT * FROM products WHERE id = ?', [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    if (!row) return res.status(404).json({ success: false, message: 'Produit introuvable' });
    res.json({
      success: true,
      source: 'sqlite',
      product: {
        id: row.id,
        name: row.name,
        description: row.description,
        price: row.price,
        originalPrice: row.originalPrice,
        category: row.category,
        stock: row.stock,
        images: safeJson(row.images, row.image ? [row.image] : []),
        rating: row.rating,
        reviewCount: row.reviewCount,
        featured: !!row.featured,
        badge: row.badge,
        tags: safeJson(row.tags, []),
        specifications: safeJson(row.specifications, {})
      }
    });
  });
});

app.get('/api/categories', (req, res) => {
  db.all('SELECT category, COUNT(*) as count FROM products GROUP BY category', [], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    const counts = {};
    (rows || []).forEach(r => { counts[r.category] = r.count; });
    const categories = CATEGORIES.map(c => ({
      ...c,
      count: counts[c.id] || 0
    }));
    res.json({ success: true, categories });
  });
});

// Supprimer un produit (admin CMD) — Supabase prioritaire
app.delete('/api/products/:id', checkAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ success: false, message: 'id invalide' });

  if (supabase) {
    try {
      const hard = req.query.hard === '1' || req.query.hard === 'true';
      if (hard) {
        const { error } = await supabase.from('products').delete().eq('id', id);
        if (error) return res.status(500).json({ success: false, message: error.message });
      } else {
        const { error } = await supabase
          .from('products')
          .update({ active: false, updated_at: new Date().toISOString() })
          .eq('id', id);
        if (error) return res.status(500).json({ success: false, message: error.message });
      }
      return res.json({
        success: true,
        source: 'supabase',
        message: hard ? 'Produit supprimé définitivement' : 'Produit désactivé (n’apparaît plus sur le site)',
        id
      });
    } catch (e) {
      return res.status(500).json({ success: false, message: e.message });
    }
  }

  db.run('DELETE FROM products WHERE id = ?', [id], function (err) {
    if (err) return res.status(500).json({ success: false, message: err.message });
    if (this.changes === 0) return res.status(404).json({ success: false, message: 'Produit introuvable' });
    res.json({ success: true, source: 'sqlite', message: 'Produit supprimé', id });
  });
});

// Ajouter / mettre à jour un produit — prioritairement Supabase
app.post('/api/products', checkAdmin, async (req, res) => {
  const p = req.body || {};
  if (!p.name || p.price == null || !p.category) {
    return res.status(400).json({ success: false, message: 'name, price, category obligatoires' });
  }
  const allowedCat = ['electronic', 'agricultural', 'mechanical', 'electrical'];
  if (!allowedCat.includes(p.category)) {
    return res.status(400).json({ success: false, message: 'category: electronic | agricultural | mechanical | electrical' });
  }
  const images = Array.isArray(p.images) ? p.images : (p.image ? [p.image] : []);

  // --- Supabase (permanent) ---
  if (supabase) {
    try {
      let id = p.id ? parseInt(p.id, 10) : null;
      if (!id) {
        const { data: maxRow } = await supabase.from('products').select('id').order('id', { ascending: false }).limit(1);
        id = (maxRow && maxRow[0] && maxRow[0].id) ? Number(maxRow[0].id) + 1 : 1001;
      }
      const row = {
        id,
        name: p.name,
        description: p.description || '',
        price: Number(p.price),
        original_price: p.originalPrice != null ? Number(p.originalPrice) : null,
        category_id: p.category,
        stock: p.stock != null ? parseInt(p.stock, 10) : 10,
        images,
        rating: p.rating != null ? Number(p.rating) : 0,
        review_count: p.reviewCount != null ? parseInt(p.reviewCount, 10) : 0,
        featured: !!p.featured,
        badge: p.badge || null,
        tags: p.tags || [],
        specifications: p.specifications || {},
        active: p.active !== false,
        updated_at: new Date().toISOString()
      };
      const { data, error } = await supabase.from('products').upsert(row, { onConflict: 'id' }).select().single();
      if (error) return res.status(500).json({ success: false, message: error.message });
      return res.json({ success: true, source: 'supabase', message: 'Produit enregistré dans Supabase', product: mapSupabaseProduct(data) });
    } catch (e) {
      return res.status(500).json({ success: false, message: e.message });
    }
  }

  // --- SQLite (secours si Supabase non configuré) ---
  const mainImage = images[0] || '';
  const finish = (id) => res.json({
    success: true,
    source: 'sqlite',
    message: 'Produit enregistré (SQLite — non permanent sur Render)',
    product: { id, name: p.name, price: Number(p.price), category: p.category, stock: p.stock || 10, images, description: p.description || '' }
  });
  if (p.id) {
    db.run(
      `INSERT OR REPLACE INTO products (id, name, description, price, originalPrice, category, stock, image, images, rating, reviewCount, featured, badge, tags, specifications)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        parseInt(p.id, 10), p.name, p.description || '', Number(p.price),
        p.originalPrice != null ? Number(p.originalPrice) : null, p.category,
        p.stock != null ? parseInt(p.stock, 10) : 10, mainImage, JSON.stringify(images),
        0, 0, p.featured ? 1 : 0, p.badge || null, JSON.stringify(p.tags || []), JSON.stringify(p.specifications || {})
      ],
      function (err) {
        if (err) return res.status(500).json({ success: false, message: err.message });
        finish(parseInt(p.id, 10));
      }
    );
  } else {
    db.run(
      `INSERT INTO products (name, description, price, originalPrice, category, stock, image, images, rating, reviewCount, featured, badge, tags, specifications)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.name, p.description || '', Number(p.price), null, p.category, p.stock || 10, mainImage, JSON.stringify(images), 0, 0, p.featured ? 1 : 0, null, '[]', '{}'],
      function (err) {
        if (err) return res.status(500).json({ success: false, message: err.message });
        finish(this.lastID);
      }
    );
  }
});

// ==================== CHECKOUT STRIPE ====================
app.post('/api/create-checkout-session', async (req, res) => {
  const sid = req.analyticsSessionId || ensureSessionId(req, res);
  trackEvent('cart_action', {
    sessionId: sid,
    path: '/api/create-checkout-session',
    meta: { action: 'checkout', itemCount: (req.body?.items || []).length },
    ip: getClientIp(req),
    userAgent: req.headers['user-agent']
  });
  const { items, customerEmail, customerName, customerPhone, customerAddress } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'Panier vide' });
  }
  if (!customerEmail || !customerName) {
    return res.status(400).json({ success: false, message: 'Email et nom requis' });
  }

  try {
    const productIds = items.map(i => parseInt(i.id, 10));
    const placeholders = productIds.map(() => '?').join(',');

    db.all(`SELECT * FROM products WHERE id IN (${placeholders})`, productIds, async (err, products) => {
      if (err) return res.status(500).json({ success: false, message: 'Erreur base de données' });

      const lineItems = [];
      let totalAmount = 0;
      const orderItemsData = [];

      for (const item of items) {
        const product = products.find(p => p.id === parseInt(item.id, 10));
        if (!product) {
          return res.status(400).json({ success: false, message: `Produit #${item.id} introuvable` });
        }
        const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
        if (product.stock < qty) {
          return res.status(400).json({
            success: false,
            message: `Stock insuffisant pour « ${product.name} » (disponible : ${product.stock})`
          });
        }

        lineItems.push({
          price_data: {
            currency: 'eur',
            product_data: {
              name: product.name,
              description: (product.description || '').substring(0, 200),
              images: product.image ? [product.image] : []
            },
            unit_amount: Math.round(product.price * 100)
          },
          quantity: qty
        });

        totalAmount += product.price * qty;
        orderItemsData.push({
          product_id: product.id,
          product_name: product.name,
          product_category: product.category || '',
          quantity: qty,
          unit_price: product.price
        });
      }

      const orderNumber = generateOrderNumber();

      db.run(
        `INSERT INTO orders (order_number, customer_email, customer_name, customer_phone, customer_address, total_amount, status, payment_status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending_payment', 'pending')`,
        [orderNumber, customerEmail, customerName, customerPhone || '', customerAddress || '', totalAmount],
        async function (insertErr) {
          if (insertErr) {
            console.error('Order insert error:', insertErr);
            return res.status(500).json({ success: false, message: 'Impossible de créer la commande' });
          }
          const orderId = this.lastID;

          const itemStmt = db.prepare(
            `INSERT INTO order_items (order_id, product_id, product_name, product_category, quantity, unit_price) VALUES (?, ?, ?, ?, ?, ?)`
          );
          orderItemsData.forEach(oi => {
            itemStmt.run(orderId, oi.product_id, oi.product_name, oi.product_category || '', oi.quantity, oi.unit_price);
          });
          itemStmt.finalize();

          // Copie permanente vers Supabase (survit au sleep Render)
          if (supabase) {
            try {
              const { data: sbOrder, error: sbErr } = await supabase.from('orders').insert({
                order_number: orderNumber,
                customer_email: customerEmail,
                customer_name: customerName,
                customer_phone: customerPhone || '',
                customer_address: customerAddress || '',
                total_amount: totalAmount,
                status: 'pending_payment',
                payment_status: 'pending'
              }).select('id').single();
              if (!sbErr && sbOrder) {
                const lines = orderItemsData.map(oi => ({
                  order_id: sbOrder.id,
                  product_id: oi.product_id,
                  product_name: oi.product_name,
                  product_category: oi.product_category || '',
                  quantity: oi.quantity,
                  unit_price: oi.unit_price
                }));
                await supabase.from('order_items').insert(lines);
              } else if (sbErr) console.warn('Supabase order insert:', sbErr.message);
            } catch (e) {
              console.warn('Supabase order copy failed', e.message);
            }
          }

          try {
            const session = await stripe.checkout.sessions.create({
              payment_method_types: ['card'],
              line_items: lineItems,
              mode: 'payment',
              success_url: `${ENV.FRONTEND_URL}/?payment=success&order=${orderNumber}`,
              cancel_url: `${ENV.FRONTEND_URL}/?payment=cancelled&order=${orderNumber}`,
              customer_email: customerEmail,
              client_reference_id: String(orderId),
              metadata: {
                order_id: String(orderId),
                order_number: orderNumber
              },
              locale: 'fr'
            });

            db.run(`UPDATE orders SET stripe_session_id = ? WHERE id = ?`, [session.id, orderId]);
            if (supabase) {
              supabase.from('orders').update({ stripe_session_id: session.id }).eq('order_number', orderNumber)
                .then(({ error }) => { if (error) console.warn('sb session id', error.message); })
                .catch(() => {});
            }

            res.json({
              success: true,
              url: session.url,
              sessionId: session.id,
              orderId,
              orderNumber
            });
          } catch (stripeErr) {
            console.error('Stripe error:', stripeErr);
            db.run(`UPDATE orders SET status = 'failed' WHERE id = ?`, [orderId]);
            res.status(500).json({ success: false, message: stripeErr.message || 'Erreur Stripe' });
          }
        }
      );
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ==================== WEBHOOK ====================
app.post('/api/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    if (ENV.STRIPE_WEBHOOK_SECRET && ENV.STRIPE_WEBHOOK_SECRET !== 'whsec_...') {
      event = stripe.webhooks.constructEvent(req.body, sig, ENV.STRIPE_WEBHOOK_SECRET);
    } else {
      // Mode dev sans secret : parser manuellement (moins sûr)
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const orderId = session.metadata?.order_id;
    const orderNumber = session.metadata?.order_number;

    if (orderId || orderNumber) {
      db.run(
        `UPDATE orders SET status = 'paid', payment_status = 'paid', updated_at = CURRENT_TIMESTAMP WHERE id = ? OR order_number = ?`,
        [orderId || null, orderNumber || null]
      );

      // Supabase permanent
      if (supabase) {
        (async () => {
          try {
            let q = supabase.from('orders').update({
              status: 'paid',
              payment_status: 'paid',
              stripe_session_id: session.id,
              updated_at: new Date().toISOString()
            });
            if (orderNumber) q = q.eq('order_number', orderNumber);
            else q = q.eq('id', orderId);
            await q;

            // Décrémenter stocks Supabase
            const { data: sbOrders } = await supabase
              .from('orders')
              .select('id')
              .eq('order_number', orderNumber || '')
              .limit(1);
            const sbId = sbOrders && sbOrders[0] && sbOrders[0].id;
            if (sbId) {
              const { data: items } = await supabase.from('order_items').select('product_id, quantity').eq('order_id', sbId);
              for (const item of items || []) {
                const { data: prod } = await supabase.from('products').select('stock').eq('id', item.product_id).maybeSingle();
                if (prod) {
                  const next = Math.max(0, (prod.stock || 0) - (item.quantity || 0));
                  await supabase.from('products').update({ stock: next }).eq('id', item.product_id);
                }
              }
            }
          } catch (e) {
            console.warn('Webhook supabase', e.message);
          }
        })();
      }

      db.all(`SELECT product_id, quantity FROM order_items WHERE order_id = ?`, [orderId], (err, items) => {
        if (!err && items) {
          items.forEach(item => {
            db.run(`UPDATE products SET stock = MAX(0, stock - ?) WHERE id = ?`, [item.quantity, item.product_id]);
          });
        }
      });

      const sendConfirm = (order) => {
        if (!order) return;
        const transporter = createTransporter();
        if (transporter) {
          transporter.sendMail({
            from: `"Félix Store" <${ENV.EMAIL_USER}>`,
            to: order.customer_email,
            subject: `Confirmation de commande ${order.order_number}`,
            html: `<h2>Merci pour votre commande</h2>
              <p>Bonjour ${order.customer_name},</p>
              <p>Votre commande <strong>${order.order_number}</strong> a bien été enregistrée.</p>
              <p>Montant : <strong>${Number(order.total_amount).toFixed(2)} €</strong></p>
              <p>— L'équipe Félix Store</p>`
          }).catch(e => console.error('Email error:', e));
        }
      };

      if (supabase && orderNumber) {
        supabase.from('orders').select('*').eq('order_number', orderNumber).maybeSingle()
          .then(({ data }) => sendConfirm(data))
          .catch(() => {});
      } else {
        db.get(`SELECT * FROM orders WHERE id = ?`, [orderId], (err, order) => {
          if (!err) sendConfirm(order);
        });
      }
    }
  }

  res.json({ received: true });
});

// ==================== ADMIN ====================
function checkAdmin(req, res, next) {
  const password = req.query.password || req.body.password || req.headers['x-admin-password'];
  if (password !== ENV.ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: 'Non autorisé' });
  }
  next();
}

app.get('/api/orders', checkAdmin, async (req, res) => {
  // Priorité Supabase (données conservées après sleep Render)
  if (supabase) {
    try {
      const { data: orders, error } = await supabase
        .from('orders')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);
      if (!error && orders && orders.length) {
        const { data: items } = await supabase.from('order_items').select('*');
        const byOrder = {};
        (items || []).forEach(it => {
          if (!byOrder[it.order_id]) byOrder[it.order_id] = [];
          byOrder[it.order_id].push(it);
        });
        return res.json({
          success: true,
          source: 'supabase',
          orders: orders.map(o => ({ ...o, items: byOrder[o.id] || [] }))
        });
      }
    } catch (e) {
      console.warn('orders supabase', e.message);
    }
  }

  db.all(`SELECT * FROM orders ORDER BY created_at DESC LIMIT 200`, [], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    const orders = rows || [];
    if (!orders.length) return res.json({ success: true, source: 'sqlite', orders: [] });
    db.all(`SELECT * FROM order_items ORDER BY id ASC`, [], (err2, allItems) => {
      if (err2) return res.status(500).json({ success: false, message: err2.message });
      const byOrder = {};
      (allItems || []).forEach(it => {
        if (!byOrder[it.order_id]) byOrder[it.order_id] = [];
        byOrder[it.order_id].push(it);
      });
      res.json({
        success: true,
        source: 'sqlite',
        orders: orders.map(o => ({ ...o, items: byOrder[o.id] || [] }))
      });
    });
  });
});

// Supprimer une commande (après livraison / litige)
app.delete('/api/orders/:id', checkAdmin, (req, res) => {
  const id = req.params.id;
  db.run(`DELETE FROM order_items WHERE order_id = ?`, [id], (err) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    db.run(`DELETE FROM orders WHERE id = ?`, [id], function (err2) {
      if (err2) return res.status(500).json({ success: false, message: err2.message });
      if (this.changes === 0) return res.status(404).json({ success: false, message: 'Commande introuvable' });
      res.json({ success: true, message: 'Commande supprimée' });
    });
  });
});

app.get('/api/orders/:id', checkAdmin, (req, res) => {
  db.get(`SELECT * FROM orders WHERE id = ?`, [req.params.id], (err, order) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    if (!order) return res.status(404).json({ success: false, message: 'Commande introuvable' });
    db.all(
      `SELECT * FROM order_items WHERE order_id = ?`,
      [req.params.id],
      (err2, items) => {
        if (err2) return res.status(500).json({ success: false, message: err2.message });
        res.json({ success: true, order, items });
      }
    );
  });
});

app.put('/api/orders/:id/status', checkAdmin, async (req, res) => {
  const { status } = req.body;
  const allowed = ['pending_payment', 'paid', 'processing', 'shipped', 'delivered', 'cancelled'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ success: false, message: 'Statut invalide' });
  }
  const paymentStatus = (status === 'paid' || status === 'processing' || status === 'shipped' || status === 'delivered')
    ? 'paid'
    : (status === 'cancelled' ? 'cancelled' : 'pending');
  const id = req.params.id;

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('orders')
        .update({ status, payment_status: paymentStatus, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select('id');
      if (error) return res.status(500).json({ success: false, message: error.message });
      if (!data || !data.length) {
        // essayer aussi SQLite
      } else {
        return res.json({ success: true, source: 'supabase', message: `Statut mis à jour : ${status}` });
      }
    } catch (e) {
      console.warn(e.message);
    }
  }

  db.run(
    `UPDATE orders SET status = ?, payment_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [status, paymentStatus, id],
    function (err) {
      if (err) return res.status(500).json({ success: false, message: err.message });
      if (this.changes === 0) return res.status(404).json({ success: false, message: 'Commande introuvable' });
      res.json({ success: true, source: 'sqlite', message: `Statut mis à jour : ${status}` });
    }
  );
});

// Envoi email groupé aux abonnés newsletter
// Utilise createBroadcastTransporter() (SMTP explicite host/port/STARTTLS, comme l'ESP32)
// au lieu du transporteur "service: 'gmail'" générique.
app.post('/api/subscribers/broadcast', checkAdmin, async (req, res) => {
  const { subject, message } = req.body || {};
  if (!subject || !message) {
    return res.status(400).json({ success: false, message: 'Sujet et message obligatoires' });
  }
  const transporter = createBroadcastTransporter();
  if (!transporter) {
    return res.status(503).json({ success: false, message: 'EMAIL_USER / EMAIL_PASSWORD non configurés sur Render' });
  }
  let list = [];
  if (supabase) {
    try {
      const { data } = await supabase.from('subscribers').select('email, nom, prenom').or('statut.eq.actif,statut.is.null');
      list = data || [];
    } catch (_) {}
  }
  const sendAll = async (rows) => {
    if (!rows.length) return res.json({ success: true, sent: 0, message: 'Aucun abonné' });
    let sent = 0;
    let failed = 0;
    for (const s of rows) {
      try {
        await transporter.sendMail({
          from: `"Félix Store" <${ENV.EMAIL_USER}>`,
          to: s.email,
          subject,
          text: message,
          html: `<p>Bonjour ${s.prenom || ''} ${s.nom || ''},</p><div>${String(message).replace(/\n/g, '<br>')}</div><p>— Félix Store</p>`
        });
        sent++;
      } catch (e) {
        failed++;
        console.error('Broadcast error', s.email, e.message);
      }
    }
    res.json({ success: true, sent, failed, total: rows.length });
  };

  if (list.length) return sendAll(list);

  db.all(`SELECT email, nom, prenom FROM subscribers WHERE statut = 'actif' OR statut IS NULL`, [], async (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    await sendAll(rows || []);
  });
});

// ========== COMPTES + ABONNÉS (Supabase permanent, SQLite secours) ==========
function customerPayload(row) {
  return {
    id: row.id,
    nom: row.nom,
    prenom: row.prenom,
    name: `${row.prenom || ''} ${row.nom || ''}`.trim(),
    email: row.email,
    date_naissance: row.date_naissance || '',
    lieu: row.lieu || '',
    profession: row.profession || '',
    pays: row.pays || '',
    ville: row.ville || ''
  };
}

app.post('/api/auth/register', async (req, res) => {
  const {
    nom, prenom, email, password,
    date_naissance, lieu, profession, pays, ville,
    subscribe_newsletter
  } = req.body || {};
  if (!nom || !prenom || !email || !password) {
    return res.status(400).json({ success: false, message: 'Nom, prénom, email et mot de passe obligatoires' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ success: false, message: 'Mot de passe trop court (min. 6)' });
  }
  const emailNorm = String(email).trim().toLowerCase();
  const fields = {
    nom: nom.trim(),
    prenom: prenom.trim(),
    email: emailNorm,
    password: String(password),
    date_naissance: date_naissance || '',
    lieu: lieu || '',
    profession: profession || '',
    pays: pays || '',
    ville: ville || ''
  };

  if (supabase) {
    try {
      const { data, error } = await supabase.from('customers').insert(fields).select().single();
      if (error) {
        if (String(error.message).includes('duplicate') || error.code === '23505') {
          return res.status(409).json({ success: false, message: 'Cet email est déjà utilisé' });
        }
        return res.status(500).json({ success: false, message: error.message });
      }
      if (subscribe_newsletter) {
        await supabase.from('subscribers').upsert({
          nom: fields.nom, prenom: fields.prenom, email: emailNorm,
          lieu: fields.lieu, profession: fields.profession, pays: fields.pays,
          ville: fields.ville, date_naissance: fields.date_naissance, statut: 'actif'
        }, { onConflict: 'email' });
      }
      return res.json({ success: true, source: 'supabase', message: 'Compte créé', customer: customerPayload(data), subscribed: !!subscribe_newsletter });
    } catch (e) {
      return res.status(500).json({ success: false, message: e.message });
    }
  }

  db.run(
    `INSERT INTO customers (nom, prenom, email, password, date_naissance, lieu, profession, pays, ville)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [fields.nom, fields.prenom, emailNorm, fields.password, fields.date_naissance, fields.lieu, fields.profession, fields.pays, fields.ville],
    function (err) {
      if (err) {
        if (err.message.includes('UNIQUE')) return res.status(409).json({ success: false, message: 'Cet email est déjà utilisé' });
        return res.status(500).json({ success: false, message: 'Erreur inscription' });
      }
      if (subscribe_newsletter) {
        db.run(
          `INSERT OR IGNORE INTO subscribers (nom, prenom, email, lieu, profession, pays, ville, date_naissance)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [fields.nom, fields.prenom, emailNorm, fields.lieu, fields.profession, fields.pays, fields.ville, fields.date_naissance]
        );
      }
      res.json({ success: true, source: 'sqlite', message: 'Compte créé', customer: customerPayload({ id: this.lastID, ...fields }), subscribed: !!subscribe_newsletter });
    }
  );
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email et mot de passe obligatoires' });
  }
  const emailNorm = String(email).trim().toLowerCase();

  if (supabase) {
    try {
      const { data, error } = await supabase.from('customers').select('*').eq('email', emailNorm).maybeSingle();
      if (error) return res.status(500).json({ success: false, message: error.message });
      if (!data || data.password !== String(password)) {
        return res.status(401).json({ success: false, message: 'Email ou mot de passe incorrect' });
      }
      await supabase.from('customers').update({ last_login: new Date().toISOString() }).eq('id', data.id);
      return res.json({ success: true, source: 'supabase', customer: customerPayload(data) });
    } catch (e) {
      return res.status(500).json({ success: false, message: e.message });
    }
  }

  db.get(
    `SELECT id, nom, prenom, email, password, date_naissance, lieu, profession, pays, ville FROM customers WHERE email = ?`,
    [emailNorm],
    (err, row) => {
      if (err) return res.status(500).json({ success: false, message: err.message });
      if (!row || row.password !== String(password)) {
        return res.status(401).json({ success: false, message: 'Email ou mot de passe incorrect' });
      }
      db.run('UPDATE customers SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [row.id]);
      res.json({ success: true, source: 'sqlite', customer: customerPayload(row) });
    }
  );
});

app.get('/api/customers', checkAdmin, async (req, res) => {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('customers')
        .select('id, nom, prenom, email, date_naissance, lieu, profession, pays, ville, created_at, last_login')
        .order('created_at', { ascending: false });
      if (error) return res.status(500).json({ success: false, message: error.message });
      return res.json({ success: true, source: 'supabase', count: (data || []).length, customers: data || [] });
    } catch (e) {
      return res.status(500).json({ success: false, message: e.message });
    }
  }
  db.all(
    `SELECT id, nom, prenom, email, date_naissance, lieu, profession, pays, ville, created_at, last_login FROM customers ORDER BY created_at DESC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ success: false, message: err.message });
      res.json({ success: true, source: 'sqlite', count: (rows || []).length, customers: rows || [] });
    }
  );
});

app.post('/api/subscribe', async (req, res) => {
  const { nom, prenom, email, lieu, profession, pays, ville, date_naissance } = req.body || {};
  if (!nom || !prenom || !email) {
    return res.status(400).json({ success: false, message: 'Champs obligatoires manquants (nom, prénom, email)' });
  }
  const emailNorm = String(email).trim().toLowerCase();
  const row = {
    nom, prenom, email: emailNorm,
    lieu: lieu || '', profession: profession || '', pays: pays || '',
    ville: ville || '', date_naissance: date_naissance || '', statut: 'actif'
  };

  if (supabase) {
    try {
      const { data, error } = await supabase.from('subscribers').upsert(row, { onConflict: 'email' }).select().single();
      if (error) return res.status(500).json({ success: false, message: error.message });
      return res.json({ success: true, source: 'supabase', message: 'Inscription réussie', id: data.id, subscriber: data });
    } catch (e) {
      return res.status(500).json({ success: false, message: e.message });
    }
  }

  db.run(
    `INSERT INTO subscribers (nom, prenom, email, lieu, profession, pays, ville, date_naissance)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [nom, prenom, emailNorm, row.lieu, row.profession, row.pays, row.ville, row.date_naissance],
    function (err) {
      if (err) {
        if (err.message.includes('UNIQUE')) return res.status(409).json({ success: false, message: 'Cet email est déjà inscrit' });
        return res.status(500).json({ success: false, message: 'Erreur inscription' });
      }
      res.json({ success: true, source: 'sqlite', message: 'Inscription réussie', id: this.lastID, subscriber: { id: this.lastID, ...row } });
    }
  );
});

app.get('/api/subscribers', checkAdmin, async (req, res) => {
  if (supabase) {
    try {
      const { data, error } = await supabase.from('subscribers').select('*').order('date_inscription', { ascending: false });
      if (error) return res.status(500).json({ success: false, message: error.message });
      return res.json({ success: true, source: 'supabase', count: (data || []).length, subscribers: data || [] });
    } catch (e) {
      return res.status(500).json({ success: false, message: e.message });
    }
  }
  db.all(
    `SELECT id, nom, prenom, email, lieu, profession, pays, ville, date_naissance, date_inscription, statut FROM subscribers ORDER BY date_inscription DESC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ success: false, message: err.message });
      res.json({ success: true, source: 'sqlite', count: (rows || []).length, subscribers: rows || [] });
    }
  );
});

app.delete('/api/subscribers/:id', checkAdmin, async (req, res) => {
  if (supabase) {
    try {
      const { error } = await supabase.from('subscribers').delete().eq('id', req.params.id);
      if (error) return res.status(500).json({ success: false, message: error.message });
      return res.json({ success: true, source: 'supabase', message: 'Abonné supprimé' });
    } catch (e) {
      return res.status(500).json({ success: false, message: e.message });
    }
  }
  db.run('DELETE FROM subscribers WHERE id = ?', [req.params.id], function (err) {
    if (err) return res.status(500).json({ success: false, message: err.message });
    if (this.changes === 0) return res.status(404).json({ success: false, message: 'Abonné introuvable' });
    res.json({ success: true, source: 'sqlite', message: 'Abonné supprimé' });
  });
});

// Contact client → email admin + archivage Supabase
app.post('/api/contact', async (req, res) => {
  const { name, email, subject, message, category } = req.body;
  if (!name || !email || !subject || !message) {
    return res.status(400).json({ success: false, message: 'Champs obligatoires manquants' });
  }

  if (supabase) {
    try {
      await supabase.from('contact_messages').insert({
        name, email, subject, message, category: category || null
      });
    } catch (e) {
      console.warn('contact_messages', e.message);
    }
  }

  const transporter = createTransporter();
  if (!transporter) {
    console.log('Contact reçu (email non configuré):', { name, email, subject, category });
    return res.json({
      success: true,
      message: supabase
        ? 'Message enregistré dans Supabase (configurez EMAIL_USER pour recevoir les mails)'
        : 'Message enregistré (configurez EMAIL_USER pour recevoir les mails)'
    });
  }
  try {
    await transporter.sendMail({
      from: `"Félix Store Contact" <${ENV.EMAIL_USER}>`,
      to: ENV.EMAIL_USER,
      replyTo: email,
      subject: `[Contact] ${subject}`,
      text: `De: ${name} <${email}>\nCatégorie: ${category || '—'}\n\n${message}`,
      html: `<p><strong>De :</strong> ${name} &lt;${email}&gt;</p>
             <p><strong>Catégorie :</strong> ${category || '—'}</p>
             <p><strong>Sujet :</strong> ${subject}</p>
             <hr><p>${String(message).replace(/\n/g, '<br>')}</p>`
    });
    res.json({ success: true, message: 'Message envoyé' });
  } catch (e) {
    console.error('Contact email error:', e);
    res.status(500).json({ success: false, message: 'Erreur envoi email' });
  }
});

// Clé publique Stripe (pour le frontend)
app.get('/api/config', (req, res) => {
  res.json({
    success: true,
    publishableKey: ENV.STRIPE_PUBLISHABLE_KEY,
    currency: 'eur',
    shippingThreshold: 100
  });
});

// ---------- Analytics API (backend only) ----------
// POST /api/analytics/event  { type, path?, productId?, meta? }
app.post('/api/analytics/event', (req, res) => {
  const { type, path, productId, meta } = req.body || {};
  const allowed = ['visit', 'page_view', 'product_view', 'cart_action', 'session'];
  if (!type || !allowed.includes(type)) {
    return res.status(400).json({ success: false, message: 'type invalide' });
  }
  const sid = req.analyticsSessionId || ensureSessionId(req, res);
  trackEvent(type, {
    sessionId: sid,
    path: path || req.headers.referer || null,
    productId: productId ? parseInt(productId, 10) : null,
    meta: meta || null,
    ip: getClientIp(req),
    userAgent: req.headers['user-agent']
  });
  res.json({ success: true, sessionId: sid });
});

// GET /api/analytics/stats?password=...
app.get('/api/analytics/stats', checkAdmin, async (req, res) => {
  const since = req.query.since || null;

  if (supabase) {
    try {
      let eventsQ = supabase.from('analytics_events').select('event_type, product_id, created_at');
      if (since) eventsQ = eventsQ.gte('created_at', since);
      const { data: events, error } = await eventsQ;
      if (error) throw error;
      const list = events || [];
      const countType = (t) => list.filter(e => e.event_type === t).length;
      let sessQ = supabase.from('analytics_sessions').select('session_id', { count: 'exact', head: true });
      if (since) sessQ = sessQ.gte('first_seen', since);
      const { count: sessionCount } = await sessQ;

      const byDayMap = {};
      list.forEach(e => {
        const day = (e.created_at || '').slice(0, 10);
        if (!day) return;
        if (!byDayMap[day]) byDayMap[day] = {};
        byDayMap[day][e.event_type] = (byDayMap[day][e.event_type] || 0) + 1;
      });
      const byDay = [];
      Object.keys(byDayMap).sort().reverse().slice(0, 90).forEach(day => {
        Object.keys(byDayMap[day]).forEach(event_type => {
          byDay.push({ day, event_type, count: byDayMap[day][event_type] });
        });
      });

      const prodMap = {};
      list.filter(e => e.event_type === 'product_view' && e.product_id).forEach(e => {
        prodMap[e.product_id] = (prodMap[e.product_id] || 0) + 1;
      });
      const topProducts = Object.entries(prodMap)
        .map(([product_id, views]) => ({ product_id: Number(product_id), views }))
        .sort((a, b) => b.views - a.views)
        .slice(0, 20);

      return res.json({
        success: true,
        source: 'supabase',
        totalVisits: countType('visit'),
        pageViews: countType('page_view'),
        productsViewed: countType('product_view'),
        cartActions: countType('cart_action'),
        sessions: sessionCount || 0,
        byDay,
        topProducts,
        gaMeasurementId: ENV.GA_MEASUREMENT_ID || null,
        generatedAt: new Date().toISOString()
      });
    } catch (e) {
      console.warn('analytics stats sb', e.message);
    }
  }

  const params = since ? [since] : [];
  const q = (sql, p = []) => new Promise((resolve, reject) => {
    db.get(sql, p, (err, row) => (err ? reject(err) : resolve(row)));
  });
  const qAll = (sql, p = []) => new Promise((resolve, reject) => {
    db.all(sql, p, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });

  try {
    const [visits, pages, products, carts, sessions, byDay, topProducts] = await Promise.all([
      q(`SELECT COUNT(*) as n FROM analytics_events WHERE event_type = 'visit' ${since ? 'AND created_at >= ?' : ''}`, params),
      q(`SELECT COUNT(*) as n FROM analytics_events WHERE event_type = 'page_view' ${since ? 'AND created_at >= ?' : ''}`, params),
      q(`SELECT COUNT(*) as n FROM analytics_events WHERE event_type = 'product_view' ${since ? 'AND created_at >= ?' : ''}`, params),
      q(`SELECT COUNT(*) as n FROM analytics_events WHERE event_type = 'cart_action' ${since ? 'AND created_at >= ?' : ''}`, params),
      q(`SELECT COUNT(*) as n FROM analytics_sessions ${since ? 'WHERE first_seen >= ?' : ''}`, params),
      qAll(
        `SELECT date(created_at) as day, event_type, COUNT(*) as count FROM analytics_events
         ${since ? 'WHERE created_at >= ?' : ''} GROUP BY date(created_at), event_type ORDER BY day DESC LIMIT 90`,
        params
      ),
      qAll(
        `SELECT product_id, COUNT(*) as views FROM analytics_events
         WHERE event_type = 'product_view' AND product_id IS NOT NULL
         ${since ? 'AND created_at >= ?' : ''} GROUP BY product_id ORDER BY views DESC LIMIT 20`,
        params
      )
    ]);
    res.json({
      success: true,
      source: 'sqlite',
      totalVisits: visits?.n || 0,
      pageViews: pages?.n || 0,
      productsViewed: products?.n || 0,
      cartActions: carts?.n || 0,
      sessions: sessions?.n || 0,
      byDay,
      topProducts,
      gaMeasurementId: ENV.GA_MEASUREMENT_ID || null,
      generatedAt: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

function safeJson(str, fallback) {
  try {
    return str ? JSON.parse(str) : fallback;
  } catch {
    return fallback;
  }
}

// ==================== ADMIN UI ====================
app.get('/admin', (req, res) => {
  const candidates = [
    path.join(__dirname, 'admin.html'),
    path.join(process.cwd(), 'admin.html'),
    path.join(process.cwd(), 'backend', 'admin.html'),
    path.join(process.cwd(), 'src', 'admin.html'),
    path.join(__dirname, '..', 'admin.html')
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) return res.sendFile(file);
  }
  console.error('admin.html introuvable. Cherché:', candidates);
  res.status(500).type('html').send(
    '<h1>admin.html manquant sur Render</h1><p>Uploade <code>admin.html</code> dans le même dossier que <code>server.js</code> puis redéploie.</p>'
  );
});

// ==================== START ====================
app.listen(ENV.PORT, '0.0.0.0', () => {
  console.log(`\nFélix Store Backend v2`);
  console.log(`Port: ${ENV.PORT}`);
  console.log(`Stripe: ${ENV.STRIPE_SECRET_KEY.startsWith('sk_') && !ENV.STRIPE_SECRET_KEY.includes('...') ? 'configuré' : 'NON CONFIGURÉ (sk_test_...)'}`);
  console.log(`Frontend URL: ${ENV.FRONTEND_URL}`);
  console.log(`Admin: http://0.0.0.0:${ENV.PORT}/admin`);
  console.log(`GA4: ${ENV.GA_MEASUREMENT_ID ? ENV.GA_MEASUREMENT_ID : 'non configuré'}`);
  console.log('');
});
