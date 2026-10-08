ALTER TABLE `orders` ADD `address_line_2` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `phone` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `paid_at` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `click_drop_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `click_drop_order_id` integer;--> statement-breakpoint
ALTER TABLE `orders` ADD `click_drop_error` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `tracking_number` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `shipped_at` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `confirmation_email_sent_at` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `shipped_email_sent_at` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `review_email_sent_at` text;--> statement-breakpoint
-- Backfill: orders placed before this integration shipped. They're never pushed to
-- Click & Drop automatically (you may already have entered them by hand — the admin
-- page has a "Send to Click & Drop" button for these), and never get a retroactive
-- confirmation email. Already-shipped ones don't get a shipped email either.
UPDATE `orders` SET `click_drop_status` = 'skipped';--> statement-breakpoint
UPDATE `orders` SET `confirmation_email_sent_at` = `created_at`, `paid_at` = `created_at` WHERE `status` IN ('paid', 'fulfilled');--> statement-breakpoint
UPDATE `orders` SET `shipped_email_sent_at` = `created_at` WHERE `status` = 'fulfilled';
