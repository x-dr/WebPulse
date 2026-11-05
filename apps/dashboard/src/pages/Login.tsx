import { useState } from 'react';
import { Button, Input } from 'antd';
import { useMutation } from '@tanstack/react-query';
import { request } from '../api/client';
import type { Session } from '../api/types';
import { Failure } from '../components/Feedback';

export function Login({
  onLogin,
  expired,
}: {
  onLogin: (session: Session) => void;
  expired: boolean;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: () =>
      request<{ data: Session }>('/auth/login', { method: 'POST', body: { username, password } }),
    onSuccess: ({ data }) => {
      setPassword('');
      onLogin(data);
    },
    onError: () => setPassword(''),
  });
  return (
    <main id="main" className="login-layout" tabIndex={-1}>
      <section className="login-intro">
        <p className="eyebrow">WEBPULSE / 网站脉搏</p>
        <h1>
          看见访问，
          <br />
          读懂变化。
        </h1>
        <p>
          流量、来源与访问趋势。
          <br />
          在自己的服务器上，掌握网站的每一次脉搏。
        </p>
        <div className="pulse-line" aria-hidden="true">
          ────╱╲──╱╲╱╲────
        </div>
        <span className="muted">数据自持 · 指标透明 · 隐私优先</span>
      </section>
      <section className="panel login-panel" aria-labelledby="login-title">
        <p className="eyebrow">回到你的工作台</p>
        <h2 id="login-title">管理员登录</h2>
        <p className="muted" role="status">
          {expired
            ? '登录已失效。重新登录后将保留站点和日期选择。'
            : '使用部署时创建的管理员账号。'}
        </p>
        {login.isError && (
          <div id="login-error">
            <Failure error={login.error} />
          </div>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            login.mutate();
          }}
        >
          <label htmlFor="username">用户名</label>
          <Input
            id="username"
            autoComplete="username"
            value={username}
            maxLength={64}
            required
            pattern="[a-zA-Z0-9_.-]+"
            disabled={login.isPending}
            onChange={(e) => setUsername(e.target.value)}
            aria-describedby={login.isError ? 'login-error' : undefined}
          />
          <label htmlFor="password">密码</label>
          <Input.Password
            id="password"
            autoComplete="current-password"
            value={password}
            maxLength={256}
            required
            disabled={login.isPending}
            onChange={(e) => setPassword(e.target.value)}
            aria-describedby={login.isError ? 'login-error' : undefined}
            aria-invalid={login.isError}
          />
          <Button type="primary" htmlType="submit" block loading={login.isPending}>
            登录工作台
          </Button>
        </form>
        <p className="muted small">首次使用？请由部署管理员创建账号。</p>
      </section>
    </main>
  );
}
