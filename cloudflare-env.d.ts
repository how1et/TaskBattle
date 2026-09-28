declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    GOOGLE_SPREADSHEET_ID?: string;
    GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  }
}
