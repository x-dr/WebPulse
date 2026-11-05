export class ConfigurationError extends Error {
  override name = 'ConfigurationError';
}

export function startupFailureMessage(error: unknown): string {
  if (error instanceof ConfigurationError) {
    return `WebPulse startup failed: ${error.message}. Check the workspace .env and README.md.\n`;
  }
  const reasons: Record<string, string> = {
    EADDRINUSE: 'Listen address already in use; check HOST and PORT',
    EACCES: 'Permission denied; check file and listen permissions',
    EPERM: 'Operation not permitted; check file and listen permissions',
    ENOENT: 'Required file or directory missing; check configuration and migration files',
  };
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    const reason = Object.hasOwn(reasons, error.code) ? reasons[error.code] : undefined;
    if (reason) return `WebPulse startup failed: ${reason}.\n`;
  }
  // Unknown driver/crypto errors may contain credentials, addresses or file contents.
  return 'WebPulse startup failed; check environment, port and migration files.\n';
}
