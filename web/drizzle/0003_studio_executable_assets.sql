ALTER TABLE `studio_sources` ADD `profile_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `studio_sources` ADD `database_path` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `studio_sources` ADD `semantic_model_path` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `studio_sources` ADD `sql_policy_path` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `studio_sources` ADD `pipeline_run_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `studio_sources` ADD `row_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `studio_sources` ADD `watermark` text DEFAULT '' NOT NULL;
