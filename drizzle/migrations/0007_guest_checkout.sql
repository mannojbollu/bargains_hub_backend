ALTER TABLE `orders` ADD `access_token` text;--> statement-breakpoint
-- Placeholder account that guest-checkout orders are filed under (GUEST_USER_ID in
-- schema.ts). The password hash is of a random secret that was thrown away, and the
-- .invalid email can't receive mail or be signed up with, so nobody can log in as it.
INSERT OR IGNORE INTO `users` (`id`, `email`, `password_hash`, `name`, `role`) VALUES ('guest', 'guest-checkout@bargainnewbooks.invalid', '$2a$10$506LNz6.AgYd3rBcyhlcMeeNDjOpWxnUXwRyGBYTls7R8JoZfJnMq', 'Guest checkout', 'customer');
