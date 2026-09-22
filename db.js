const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'shop.db'));

// Enable WAL mode for high concurrency (readers don't block writers)
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,               -- e.g. 'RG-0001', 'NK-0002'
    name TEXT NOT NULL,
    category TEXT NOT NULL,           -- 'Ring', 'Necklace', 'Bracelet', 'Earring'
    import_price REAL NOT NULL,       -- for owner margin calculation
    sell_price REAL NOT NULL,
    stock INTEGER NOT NULL DEFAULT 0,
    photo_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,               -- e.g. 'ORD-1727000000000'
    psid TEXT NOT NULL,                -- verified Messenger PSID
    status TEXT NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'CONFIRMED', 'CANCELLED'
    total_amount REAL NOT NULL,
    customer_name TEXT,
    phone TEXT,
    address TEXT,
    note TEXT,                         -- e.g. 'Ring size 7'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_price REAL NOT NULL,
    FOREIGN KEY(order_id) REFERENCES orders(id),
    FOREIGN KEY(product_id) REFERENCES products(id)
  );
`);

// Insert initial demo jewelry products if empty
const count = db.prepare('SELECT COUNT(*) as count FROM products').get().count;
if (count === 0) {
  const insertProduct = db.prepare(`
    INSERT INTO products (id, name, category, import_price, sell_price, stock, photo_url)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  insertProduct.run(
    'RG-0001',
    'Diamond Solitaire Gold Ring',
    'Ring',
    35.00,
    75.00,
    5,
    'https://images.unsplash.com/photo-1605100804763-247f67b3557e?w=500&q=80'
  );
  insertProduct.run(
    'NK-0001',
    '18K Pearl Pendant Necklace',
    'Necklace',
    45.00,
    95.00,
    3,
    'https://images.unsplash.com/photo-1599643478518-a784e5dc4c8f?w=500&q=80'
  );
  insertProduct.run(
    'BR-0001',
    'Classic Minimalist Silver Bangle',
    'Bracelet',
    20.00,
    45.00,
    8,
    'https://images.unsplash.com/photo-1611591475152-47e2467d519b?w=500&q=80'
  );
}

module.exports = db;
