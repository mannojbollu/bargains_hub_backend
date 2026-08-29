ALTER TABLE `orders` ADD `stripe_session_id` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `stripe_payment_intent_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `orders_stripe_session_idx` ON `orders` (`stripe_session_id`);
