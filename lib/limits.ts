/** Public constraints only. Never put answers or access keys in shared modules. */
export const LIMITS = {
  tasks: 25,
  answerLength: 200,
  titleLength: 100,
  attempts: 120,
  roomTtlMs: 14 * 24 * 3600000,
  attemptTtlMs: 24 * 3600000,
  resultTtlMs: 72 * 3600000,
  fileBytes: 3 * 1024 * 1024,
  roomBytes: 18 * 1024 * 1024,
  inputBytes: 30 * 1024 * 1024,
  inputPixels: 60000000,
  storedPixels: 40000000,
  imageEdge: 2560,
  photoTimeoutMs: 45000,
  imageTimeoutMs: 20000,
  uploadTimeoutMs: 60000,
  photoConcurrency: 2,
} as const;
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
