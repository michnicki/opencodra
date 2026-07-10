INSERT INTO global_settings (key, value) VALUES
  ('review_concurrency_level', 'medium'),
  ('review_max_comments', '10')
ON CONFLICT (key) DO NOTHING;
