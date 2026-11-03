import type { HealthResponse } from '@webpulse/shared';

export async function fetchHealth(
  check: HealthResponse['check'],
  signal: AbortSignal,
): Promise<HealthResponse> {
  const response = await fetch(`/api/v1/health/${check}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('服务暂时不可用');
  const data: unknown = await response.json();
  if (
    typeof data !== 'object' ||
    data === null ||
    !('status' in data) ||
    data.status !== 'ok' ||
    !('service' in data) ||
    data.service !== 'webpulse' ||
    !('check' in data) ||
    data.check !== check
  )
    throw new Error('服务响应无效');
  return { status: 'ok', service: 'webpulse', check };
}
