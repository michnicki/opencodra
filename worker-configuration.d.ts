declare interface Ai {
  run(model: string, input: Record<string, unknown>): Promise<any>;
}

declare interface Env {
  AI: Ai;
  APP_KV: KVNamespace;
  REVIEW_QUEUE: Queue<any>;
  ASSETS: Fetcher;
  APP_PRIVATE_KEY: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_WEBHOOK_SECRET: string;
  GEMINI_API_KEY: string;
  GEMINI_MODEL: string;
  NEON_DATABASE_URL: string;
  DASHBOARD_PASSWORD: string;
  BOT_USERNAME: string;
  ENVIRONMENT: string;
}
