export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

export async function request<T>(
  path: string,
  options: {
    signal?: AbortSignal;
    method?: string;
    body?: unknown;
    csrf?: string;
    key?: string;
  } = {},
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
    method: options.method ?? 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(options.csrf ? { 'X-CSRF-Token': options.csrf } : {}),
      ...(options.key ? { 'Idempotency-Key': options.key } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  if (response.status === 204) return undefined as T;
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code =
      isObject(json) && isObject(json.error) && typeof json.error.code === 'string'
        ? json.error.code
        : 'request_failed';
    if (response.status === 401 && path !== '/auth/login') {
      window.dispatchEvent(new Event('webpulse:unauthorized'));
    }
    throw new ApiError(response.status, code);
  }
  if (!isObject(json) || !('data' in json)) throw new ApiError(502, 'invalid_response');
  return json as T;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const errors: Record<string, string> = {
  invalid_credentials: '用户名或密码不正确，请重新输入。',
  auth_required: '登录已失效，请重新登录。',
  csrf_invalid: '安全校验已失效，请退出后重新登录。',
  origin_denied: '管理入口与服务配置不一致，请检查管理员访问地址。',
  invalid_origin: 'Origin 必须只含协议、域名和端口，并包含在允许列表中。',
  invalid_timezone: '请输入有效的 IANA 时区，例如 Asia/Shanghai。',
  site_maintenance: '站点正在维护，报表暂不可用。请在站点设置中查看任务。',
  recovery_locked: '恢复校验尚未完成，服务暂不可用。请联系部署管理员。',
  maintenance_in_progress: '站点维护中，完成后再修改设置。',
  site_not_found: '站点已不存在，请选择其他站点。',
  invalid_schema: '提交内容无效，请检查字段及日期范围。',
  invalid_date_range: '日期范围无效，请选择最多 365 个自然日。',
  range_too_large: '日期范围过长，请缩小到 365 个自然日以内。',
  future_range: '不能查询未来日期，请调整日期范围。',
  too_many_points: '当前粒度数据点过多，请缩短范围或改用日粒度。',
  confirmation_mismatch: '站点名称不一致，请重新确认。',
  deletion_key_unavailable: '删除服务尚未配置，未受理删除。请联系部署管理员。',
  invalid_response: '服务返回的数据格式无效，请重试。',
  invalid_retention: '保留天数不符合范围或先后顺序。',
};
export function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    return (
      errors[error.code] ??
      (error.status === 429
        ? '请求过于频繁，请稍后重试。'
        : error.status >= 500
          ? '服务暂时不可用，请稍后重试。'
          : '请求失败，请检查输入后重试。')
    );
  }
  return '连接失败，请检查网络后重试。';
}
