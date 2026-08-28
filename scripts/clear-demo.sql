-- Wipes the fictional demo catalog seeded by scripts/seed.ts, leaving real
-- customer accounts and orders untouched. Safe to run once when moving from
-- demo data to a real inventory. Order matches FK dependency order.
DELETE FROM order_items;
DELETE FROM orders WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'seed+%@bookishbargains.invalid');
DELETE FROM wishlist_items;
DELETE FROM reviews;
DELETE FROM books;
DELETE FROM users WHERE email LIKE 'seed+%@bookishbargains.invalid';
