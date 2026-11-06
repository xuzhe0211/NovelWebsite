-- 免费小说小程序数据库结构（参考用；开发期由 sequelize.sync 自动建表）
CREATE DATABASE IF NOT EXISTS `novel` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE `novel`;

CREATE TABLE IF NOT EXISTS `users` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `openid` VARCHAR(64) NOT NULL,
  `nickname` VARCHAR(64) DEFAULT NULL,
  `avatar` VARCHAR(512) DEFAULT NULL,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_users_openid` (`openid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `categories` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(32) NOT NULL,
  `slug` VARCHAR(32) NOT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_categories_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `novels` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `source_id` VARCHAR(64) NOT NULL COMMENT '站点小说ID',
  `source_url` VARCHAR(512) DEFAULT NULL COMMENT '源站书籍页链接，供继续补章',
  `title` VARCHAR(128) NOT NULL,
  `author` VARCHAR(64) DEFAULT NULL,
  `category_id` INT UNSIGNED DEFAULT NULL,
  `cover_url` VARCHAR(512) DEFAULT NULL,
  `intro` TEXT,
  `status` VARCHAR(16) NOT NULL DEFAULT '连载中',
  `is_completed` TINYINT(1) NOT NULL DEFAULT 0,
  `last_chapter_id` INT UNSIGNED DEFAULT NULL,
  `last_chapter_title` VARCHAR(128) DEFAULT NULL,
  `word_count` BIGINT NOT NULL DEFAULT 0,
  `click_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `rating` DECIMAL(3,1) NOT NULL DEFAULT 0.0,
  `last_update_time` DATETIME DEFAULT NULL,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_novels_source_id` (`source_id`),
  KEY `idx_novels_category` (`category_id`),
  KEY `idx_novels_click` (`click_count`),
  KEY `idx_novels_update` (`last_update_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `chapters` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `novel_id` INT UNSIGNED NOT NULL,
  `source_chapter_id` VARCHAR(64) NOT NULL,
  `chapter_no` INT UNSIGNED NOT NULL,
  `title` VARCHAR(128) NOT NULL,
  `content` LONGTEXT COMMENT '正文（简体），段落以换行分隔',
  `word_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_novel_src_chapter` (`novel_id`, `source_chapter_id`),
  KEY `idx_novel_chapter_no` (`novel_id`, `chapter_no`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `bookshelves` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` INT UNSIGNED NOT NULL,
  `novel_id` INT UNSIGNED NOT NULL,
  `last_chapter_id` INT UNSIGNED DEFAULT NULL,
  `last_position` FLOAT NOT NULL DEFAULT 0 COMMENT '章节内滚动百分比 0-100',
  `last_read_time` DATETIME DEFAULT NULL,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_user_novel` (`user_id`, `novel_id`),
  KEY `idx_bookshelf_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
