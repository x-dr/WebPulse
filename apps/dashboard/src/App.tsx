import { Button } from 'antd';
import { useQueries } from '@tanstack/react-query';
import { fetchHealth } from './api/health';

const checks = [
  { key: 'live', label: '应用服务', available: '连接正常', unavailable: '连接中断' },
  { key: 'ready', label: '数据服务', available: '已就绪', unavailable: '尚未就绪' },
] as const;

export function App() {
  const results = useQueries({
    queries: checks.map(({ key }) => ({
      queryKey: ['health', key],
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchHealth(key, signal),
      staleTime: 10_000,
    })),
  });
  const checking = results.some(({ isFetching }) => isFetching);
  const failed = results.some(({ isError }) => isError);

  return (
    <div className="workspace">
      <a className="skip-link" href="#main">
        跳转到主要内容
      </a>
      <header className="header">
        <a className="brand" href="/" aria-label="WebPulse 网站脉搏首页">
          <span className="brand-mark" aria-hidden="true">
            W<span>·</span>
          </span>
          <span>
            WebPulse <span className="brand-subtitle">网站脉搏</span>
          </span>
        </a>
        <span className="stage">开发预览 · 初始化</span>
      </header>

      <main id="main" tabIndex={-1}>
        <section className="intro" aria-labelledby="welcome-title">
          <p className="eyebrow">让每一次访问，清晰可见</p>
          <h1 id="welcome-title">
            你的网站，
            <br className="mobile-break" />
            即将有迹可循。
          </h1>
          <p className="intro-copy">
            流量、来源与访问趋势，在自己的服务器上掌握。
            <br />
            WebPulse 的第一步，从准备好工作台开始。
          </p>
        </section>

        <section className="status-panel" aria-labelledby="status-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">工作台状态</p>
              <h2 id="status-title">基础连接</h2>
            </div>
            <Button
              loading={checking}
              onClick={() => {
                void Promise.all(results.map((result) => result.refetch()));
              }}
            >
              重新检查
            </Button>
          </div>
          <div className="status-grid" aria-live="polite" aria-busy={checking}>
            {checks.map((check, index) => {
              const result = results[index]!;
              const status = result.isFetching
                ? '检查中'
                : result.isError
                  ? check.unavailable
                  : check.available;
              return (
                <div className="status-item" key={check.key}>
                  <span className="status-label">{check.label}</span>
                  <p className={`status-value ${result.isError ? 'unavailable' : ''}`}>
                    <span className="status-dot" aria-hidden="true" />
                    {status}
                  </p>
                </div>
              );
            })}
          </div>
          <p className="status-note" role="status">
            {checking
              ? '正在检查服务连接…'
              : failed
                ? '部分服务尚未准备好。请完成服务配置后，重新检查。'
                : '基础服务已连接。站点管理与流量统计将在后续阶段开放。'}
          </p>
        </section>

        <section className="coming-next" aria-labelledby="next-title">
          <div className="section-heading">
            <h2 id="next-title">接下来，开始了解你的访客</h2>
            <span className="muted">功能筹备中</span>
          </div>
          <ol className="steps">
            <li>
              <span className="step-number">01</span>
              <div>
                <h3>创建你的站点</h3>
                <p>设置网站地址与时区，让数据各归其位。</p>
              </div>
            </li>
            <li>
              <span className="step-number">02</span>
              <div>
                <h3>接入轻量采集</h3>
                <p>在访客同意之后，记录最必要的访问数据。</p>
              </div>
            </li>
            <li>
              <span className="step-number">03</span>
              <div>
                <h3>看见访问趋势</h3>
                <p>从真实访问出发，读懂网站的每一次变化。</p>
              </div>
            </li>
          </ol>
        </section>
      </main>
      <footer>
        <span>WebPulse · 网站脉搏</span>
        <span>数据自持，指标透明。</span>
      </footer>
    </div>
  );
}
