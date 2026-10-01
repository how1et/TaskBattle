declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    GOOGLE_SPREADSHEET_ID?: string;
    GOOGLE_SERVICE_ACCOUNT_JSON?: string;
    MIGRATION_SECRET?: string;
    MIGRATION_DRAIN?: string;
    MIGRATION_TARGET_ORIGIN?: string;
    MIGRATION_SOURCE_ORIGIN?: string;
    MIGRATION_BRIDGE_KEY?: string;
    CLEANUP_SECRET?: string;
    RUNTIME?: string;
    APP_ORIGIN?: string;
    MAINTENANCE?: boolean;
  }
}
