const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const QRCode = require('qrcode');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'store.db');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

for (const dir of [DATA_DIR, UPLOAD_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL,
    referrer_id INTEGER REFERENCES customers(id)
  );
  CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    visit_date TEXT NOT NULL,
    scanned_at TEXT NOT NULL,
    UNIQUE(customer_id, visit_date)
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    order_type TEXT NOT NULL DEFAULT 'sale',
    source_order_id INTEGER,
    amount_cents INTEGER NOT NULL DEFAULT 0,
    points_used INTEGER NOT NULL DEFAULT 0,
    paid_cents INTEGER NOT NULL DEFAULT 0,
    points_earned INTEGER NOT NULL DEFAULT 0,
    referrer_id INTEGER REFERENCES customers(id),
    order_date TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    voided_at TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  INSERT OR IGNORE INTO settings (key, value) VALUES ('store_name', '服装店');
`);

function pad(n) {
  return String(n).padStart(2, '0');
}

function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function nowStr() {
  const d = new Date();
  return `${todayStr(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readJson(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(httpError(413, '数据过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      if (!raw.length) return resolve({});
      try {
        resolve(JSON.parse(raw.toString('utf8')));
      } catch {
        reject(httpError(400, '请求数据格式错误'));
      }
    });
    req.on('error', reject);
  });
}

function getLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

function getByPhone(phone) {
  return db.prepare('SELECT * FROM customers WHERE phone = ?').get(phone);
}

function getCustomer(id) {
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
}

function getOrder(id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
}

function summaryFor(customerId, date = todayStr()) {
  const rows = db.prepare(`
    SELECT order_type, order_date, points_earned, points_used, amount_cents, paid_cents
    FROM orders
    WHERE customer_id = ? AND status = 'active'
  `).all(customerId);
  let earnedBefore = 0;
  let earnedToday = 0;
  let used = 0;
  let saleCount = 0;
  let totalPaidCents = 0;
  let totalPointsEarned = 0;
  for (const row of rows) {
    totalPointsEarned += row.points_earned;
    totalPaidCents += row.paid_cents;
    if (row.order_type === 'sale') saleCount += 1;
    if (row.order_date < date) earnedBefore += row.points_earned;
    if (row.order_date === date) earnedToday += row.points_earned;
    used += row.points_used;
  }
  return {
    available: Math.max(0, earnedBefore - used),
    todayEarned: earnedToday,
    saleCount,
    isNew: saleCount === 0,
    totalPaidCents,
    totalPointsEarned
  };
}

function publicCustomer(customer) {
  const sum = summaryFor(customer.id);
  const referrer = customer.referrer_id ? getCustomer(customer.referrer_id) : null;
  return {
    id: customer.id,
    phone: customer.phone,
    createdAt: customer.created_at,
    referrerId: customer.referrer_id || null,
    referrerPhone: referrer ? referrer.phone : null,
    available: sum.available,
    todayEarned: sum.todayEarned,
    saleCount: sum.saleCount,
    isNew: sum.isNew,
    totalPaidCents: sum.totalPaidCents,
    totalPointsEarned: sum.totalPointsEarned
  };
}

function rowToOrder(row) {
  return {
    id: row.id,
    type: row.order_type,
    customerId: row.customer_id,
    customerPhone: row.customer_phone || null,
    amountCents: row.amount_cents,
    pointsUsed: row.points_used,
    paidCents: row.paid_cents,
    pointsEarned: row.points_earned,
    orderDate: row.order_date,
    createdAt: row.created_at,
    status: row.status,
    referrerPhone: row.referrer_phone || null,
    sourceOrderId: row.source_order_id || null
  };
}

function historyFor(customerId) {
  const rows = db.prepare(`
    SELECT o.*, c.phone AS customer_phone, r.phone AS referrer_phone
    FROM orders o
    LEFT JOIN customers c ON c.id = o.customer_id
    LEFT JOIN customers r ON r.id = o.referrer_id
    WHERE o.customer_id = ?
    ORDER BY o.created_at DESC, o.id DESC
  `).all(customerId);
  return rows.map(rowToOrder);
}

function handleScan(body) {
  const phone = String(body.phone || '').trim();
  if (!/^\d{6,15}$/.test(phone)) throw httpError(400, '请输入正确的手机号');
  let customer = getByPhone(phone);
  let created = false;
  if (!customer) {
    db.prepare('INSERT INTO customers (phone, created_at) VALUES (?, ?)').run(phone, nowStr());
    customer = getByPhone(phone);
    created = true;
  }
  db.prepare(`
    INSERT INTO visits (customer_id, visit_date, scanned_at)
    VALUES (?, ?, ?)
    ON CONFLICT(customer_id, visit_date) DO UPDATE SET scanned_at = excluded.scanned_at
  `).run(customer.id, todayStr(), nowStr());
  const visitCount = db.prepare(`
    SELECT COUNT(DISTINCT visit_date) AS n FROM visits WHERE customer_id = ?
  `).get(customer.id).n;
  return {
    customer: publicCustomer(customer),
    created,
    visitCount,
    message: created ? '登记成功，欢迎光临' : `欢迎回来，这是第 ${visitCount} 次到店`
  };
}

function handleToday() {
  const date = todayStr();
  const visitRows = db.prepare(`
    SELECT v.id, v.visit_date, v.scanned_at, c.id AS customer_id, c.phone, c.created_at
    FROM visits v
    JOIN customers c ON c.id = v.customer_id
    WHERE v.visit_date = ?
    ORDER BY v.scanned_at DESC, v.id DESC
  `).all(date);
  const visits = visitRows.map((row) => {
    const customer = getCustomer(row.customer_id);
    return {
      id: row.id,
      scannedAt: row.scanned_at,
      customer: publicCustomer(customer)
    };
  });
  const orderRows = db.prepare(`
    SELECT o.*, c.phone AS customer_phone, r.phone AS referrer_phone
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    LEFT JOIN customers r ON r.id = o.referrer_id
    WHERE o.order_date = ? AND o.order_type = 'sale'
    ORDER BY o.created_at DESC, o.id DESC
  `).all(date);
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'active' THEN paid_cents ELSE 0 END), 0) AS paid_cents,
      COALESCE(SUM(CASE WHEN status = 'active' THEN points_used ELSE 0 END), 0) AS points_used,
      COALESCE(SUM(CASE WHEN status = 'active' THEN points_earned ELSE 0 END), 0) AS points_earned
    FROM orders
    WHERE order_date = ?
  `).get(date);
  return {
    date,
    visits,
    orders: orderRows.map(rowToOrder),
    totals: {
      paidCents: totals.paid_cents,
      pointsUsed: totals.points_used,
      pointsEarned: totals.points_earned
    }
  };
}

function handleCustomerDetail(id) {
  const customer = getCustomer(id);
  if (!customer) throw httpError(404, '客人不存在');
  return {
    customer: publicCustomer(customer),
    history: historyFor(id)
  };
}

function handleCustomerSearch(query) {
  const q = String(query || '').trim();
  if (!q) return { customers: [] };
  const rows = db.prepare(`
    SELECT * FROM customers WHERE phone LIKE ? ORDER BY id DESC LIMIT 20
  `).all(`%${q}%`);
  return { customers: rows.map(publicCustomer) };
}

function handleCreateOrder(body) {
  const customerId = Number(body.customerId);
  const amountCents = Math.round(Number(body.amountCents));
  const pointsUsed = Math.round(Number(body.pointsUsed || 0));
  if (!Number.isInteger(customerId) || customerId <= 0) throw httpError(400, '客人信息不正确');
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > 100000000) {
    throw httpError(400, '请输入正确的应收金额');
  }
  if (!Number.isInteger(pointsUsed) || pointsUsed < 0) throw httpError(400, '抵扣积分不正确');
  if (pointsUsed * 100 > amountCents) throw httpError(400, '抵扣不能超过应收金额');

  const customer = getCustomer(customerId);
  if (!customer) throw httpError(404, '客人不存在');
  const before = summaryFor(customer.id);
  if (pointsUsed > before.available) {
    throw httpError(400, `可用积分不足，最多可用 ${before.available} 积分`);
  }

  const paidCents = amountCents - pointsUsed * 100;
  const pointsEarned = Math.round(paidCents / 10000);
  const referrerPhone = String(body.referrerPhone || '').trim();
  let referrer = null;
  if (referrerPhone) {
    if (!before.isNew) throw httpError(400, '该客人已有消费记录，不能再绑定老客');
    referrer = getByPhone(referrerPhone);
    if (!referrer) throw httpError(400, '老客手机号不存在');
    if (referrer.id === customer.id) throw httpError(400, '不能把自己绑定为老客');
  }

  const now = nowStr();
  let orderId = null;
  let referralOrderId = null;
  db.exec('BEGIN');
  try {
    const result = db.prepare(`
      INSERT INTO orders (
        customer_id, order_type, amount_cents, points_used, paid_cents,
        points_earned, referrer_id, order_date, created_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(customer.id, 'sale', amountCents, pointsUsed, paidCents, pointsEarned, referrer ? referrer.id : null, todayStr(), now);
    orderId = Number(result.lastInsertRowid);
    if (referrer) {
      db.prepare('UPDATE customers SET referrer_id = ? WHERE id = ?').run(referrer.id, customer.id);
      const referralResult = db.prepare(`
        INSERT INTO orders (
          customer_id, order_type, source_order_id, amount_cents, points_used,
          paid_cents, points_earned, referrer_id, order_date, created_at, status
        ) VALUES (?, 'referral', ?, 0, 0, 0, ?, NULL, ?, ?, 'active')
      `).run(referrer.id, orderId, pointsEarned, todayStr(), now);
      referralOrderId = Number(referralResult.lastInsertRowid);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const after = summaryFor(customer.id);
  const updatedCustomer = getCustomer(customer.id);
  return {
    order: rowToOrder(db.prepare(`
      SELECT o.*, c.phone AS customer_phone, r.phone AS referrer_phone
      FROM orders o
      LEFT JOIN customers c ON c.id = o.customer_id
      LEFT JOIN customers r ON r.id = o.referrer_id
      WHERE o.id = ?
    `).get(orderId)),
    referralOrderId,
    pointsEarned,
    availableAfter: after.available,
    customer: publicCustomer(updatedCustomer),
    referrer: referrer ? publicCustomer(referrer) : null
  };
}

function handleVoidOrder(orderId) {
  const order = getOrder(orderId);
  if (!order || order.order_type !== 'sale') throw httpError(404, '订单不存在');
  if (order.status === 'void') throw httpError(400, '订单已经是撤销状态');
  const now = nowStr();
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE orders SET status = ?, voided_at = ? WHERE id = ?').run('void', now, orderId);
    db.prepare(`
      UPDATE orders SET status = ?, voided_at = ? WHERE source_order_id = ? AND order_type = 'referral'
    `).run('void', now, orderId);
    const remainingSales = db.prepare(`
      SELECT COUNT(*) AS n FROM orders
      WHERE customer_id = ? AND status = 'active' AND order_type = 'sale'
    `).get(order.customer_id).n;
    if (remainingSales === 0) {
      db.prepare('UPDATE customers SET referrer_id = NULL WHERE id = ?').run(order.customer_id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  const updated = getOrder(orderId);
  return {
    order: updated,
    buyer: publicCustomer(getCustomer(order.customer_id)),
    referrer: order.referrer_id ? publicCustomer(getCustomer(order.referrer_id)) : null
  };
}

function handleSettings(body) {
  const storeName = String(body.storeName || '').trim();
  if (!storeName || storeName.length > 20) throw httpError(400, '店铺名称需为 1-20 个字符');
  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('store_name', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(storeName);
  return { storeName };
}

function handleUpload(body) {
  const type = body.type;
  if (!['wechat', 'alipay'].includes(type)) throw httpError(400, '收款码类型不正确');
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.dataUrl || ''));
  if (!match) throw httpError(400, '请选择 PNG、JPG 或 WebP 图片');
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 3 * 1024 * 1024) throw httpError(400, '图片不能超过 3MB');
  const ext = match[1] === 'image/jpeg' ? 'jpg' : match[1].replace('image/', '');
  const filename = `${type}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer);
  for (const old of fs.readdirSync(UPLOAD_DIR)) {
    if (old.startsWith(`${type}.`) && old !== filename) {
      fs.unlinkSync(path.join(UPLOAD_DIR, old));
    }
  }
  return { url: `/uploads/${filename}` };
}

async function handleQr() {
  const lanIp = getLanIp();
  const url = `http://${lanIp}:${PORT}/scan.html`;
  const dataUrl = await QRCode.toDataURL(url, {
    errorCorrectionLevel: 'M',
    width: 320,
    margin: 1,
    color: { dark: '#0f172a', light: '#ffffff' }
  });
  return { url, dataUrl };
}

function safeJoin(root, rel) {
  const clean = path.normalize(String(rel || '')).replace(/^([/\\])+/, '');
  const full = path.resolve(root, clean);
  if (!full.startsWith(path.resolve(root))) return null;
  return full;
}

function serveStatic(req, res, pathname) {
  let filePath;
  if (pathname === '/') {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  } else if (pathname.startsWith('/uploads/')) {
    filePath = safeJoin(UPLOAD_DIR, pathname.slice('/uploads/'.length));
  } else {
    filePath = safeJoin(PUBLIC_DIR, pathname.slice(1));
  }
  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    sendError(res, 404, '文件不存在');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml; charset=utf-8',
    '.ico': 'image/x-icon'
  }[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
  fs.createReadStream(filePath).pipe(res);
}

function sendError(res, status, message) {
  json(res, status, { error: message });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (req.method === 'GET' && p === '/api/health') return json(res, 200, { ok: true });
    if (req.method === 'GET' && p === '/api/today') return json(res, 200, handleToday());
    if (req.method === 'GET' && p === '/api/settings') {
      const storeName = db.prepare(`SELECT value FROM settings WHERE key = 'store_name'`).get().value;
      return json(res, 200, { storeName });
    }
    if (req.method === 'GET' && p === '/api/qr') return json(res, 200, await handleQr());
    if (req.method === 'GET' && p === '/api/customers/search') {
      return json(res, 200, handleCustomerSearch(url.searchParams.get('q')));
    }
    const customerMatch = p.match(/^\/api\/customers\/(\d+)$/);
    if (req.method === 'GET' && customerMatch) {
      return json(res, 200, handleCustomerDetail(Number(customerMatch[1])));
    }

    if (req.method === 'POST' && p === '/api/scan') {
      return json(res, 200, handleScan(await readJson(req)));
    }
    if (req.method === 'POST' && p === '/api/orders') {
      return json(res, 200, handleCreateOrder(await readJson(req)));
    }
    if (req.method === 'POST' && p === '/api/settings') {
      return json(res, 200, handleSettings(await readJson(req)));
    }
    if (req.method === 'POST' && p === '/api/upload') {
      return json(res, 200, handleUpload(await readJson(req)));
    }
    const voidMatch = p.match(/^\/api\/orders\/(\d+)\/void$/);
    if (req.method === 'POST' && voidMatch) {
      return json(res, 200, handleVoidOrder(Number(voidMatch[1])));
    }

    if (p.startsWith('/api/')) return sendError(res, 404, '接口不存在');
    return serveStatic(req, res, p);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    sendError(res, status, err.message || '服务器错误');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`SHE 服装店系统已启动`);
  console.log(`本机访问: http://localhost:${PORT}`);
  console.log(`局域网访问: http://${getLanIp()}:${PORT}`);
});
