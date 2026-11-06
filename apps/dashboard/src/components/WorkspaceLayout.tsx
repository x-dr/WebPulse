import { useState, type ReactNode } from 'react';
import { Button, Select } from 'antd';
import type { Session, Site } from '../api/types';
import type { Navigate } from '../navigation';
import { PulseMark, WorkspaceIcon, type WorkspaceIconName } from './WorkspaceIcon';

const navigation: { href: string; label: string; icon: WorkspaceIconName }[] = [
  { href: '/overview', label: '总览', icon: 'overview' },
  { href: '/realtime', label: '实时', icon: 'realtime' },
  { href: '/sources', label: '来源', icon: 'sources' },
  { href: '/pages', label: '页面', icon: 'pages' },
  { href: '/visitors', label: '访客', icon: 'visitors' },
  { href: '/sites', label: '站点设置', icon: 'settings' },
];

export function workspaceTitle(path: string) {
  if (path.startsWith('/jobs/')) return '删除任务';
  if (path === '/sites') return '站点管理';
  return navigation.find(({ href }) => path.startsWith(href))?.label ?? '工作台';
}

export function WorkspaceLayout({
  session,
  site,
  sites,
  sitesPending,
  path,
  url,
  navigate,
  selectSite,
  onLogout,
  loggingOut,
  children,
}: {
  session: Session;
  site: Site | undefined;
  sites: Site[];
  sitesPending: boolean;
  path: string;
  url: URL;
  navigate: Navigate;
  selectSite: (id: string) => void;
  onLogout: () => void;
  loggingOut: boolean;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className={`workspace${collapsed ? ' workspace--collapsed' : ''}`}>
      <a className="skip-link" href="#main">
        跳转到主要内容
      </a>
      <aside className="sidebar" id="workspace-sidebar">
        <a
          className="brand"
          href="/overview"
          aria-label="WebPulse 网站脉搏"
          onClick={(event) => {
            event.preventDefault();
            navigate('/overview');
          }}
        >
          <span className="brand-mark">
            <PulseMark compact />
          </span>
          <span className="brand-copy">
            WebPulse<span className="brand-subtitle">网站脉搏</span>
          </span>
        </a>
        <nav className="navigation" aria-label="主要导航">
          <p className="nav-group-label">数据分析</p>
          {navigation.map(({ href, label, icon }) => {
            const target = href === '/sites' && site ? `/sites/${site.site_id}/settings` : href;
            return (
              <div className={href === '/sites' ? 'nav-management' : 'nav-item'} key={href}>
                {href === '/sites' && <p className="nav-group-label">管理</p>}
                <a
                  href={target + url.search}
                  aria-label={label}
                  title={label}
                  aria-current={path.startsWith(href) ? 'page' : undefined}
                  onClick={(event) => {
                    event.preventDefault();
                    navigate(target);
                  }}
                >
                  <WorkspaceIcon name={icon} />
                  <span className="nav-link-label">{label}</span>
                </a>
              </div>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <div className="privacy-note">
            <WorkspaceIcon name="shield" />
            <div>
              <strong>数据自持</strong>
              <span>你的数据，由你掌握</span>
            </div>
          </div>
          <p>WebPulse / 自托管统计</p>
        </div>
      </aside>
      <div className="workspace-body">
        <header className="header">
          <div className="header-location">
            <button
              className="icon-button sidebar-toggle"
              type="button"
              aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
              aria-expanded={!collapsed}
              aria-controls="workspace-sidebar"
              onClick={() => setCollapsed(!collapsed)}
            >
              <WorkspaceIcon name="menu" />
            </button>
            <nav className="breadcrumbs" aria-label="面包屑">
              <span>工作空间</span>
              <span aria-hidden="true">/</span>
              <span aria-current="page">{workspaceTitle(path)}</span>
            </nav>
          </div>
          <div className="header-actions">
            <div className="site-selector">
              <label className="sr-only" htmlFor="site-selector">
                当前站点
              </label>
              <Select
                id="site-selector"
                aria-label="当前站点"
                value={site?.site_id ?? null}
                placeholder="选择站点"
                prefix={<WorkspaceIcon name="globe" />}
                loading={sitesPending}
                options={sites.map((s) => ({ value: s.site_id, label: s.name }))}
                onChange={selectSite}
              />
            </div>
            <Button
              className="create-site-button"
              onClick={() => navigate('/sites', { create: '1' })}
            >
              新建站点
            </Button>
            <div className="account">
              <span className="account-avatar" aria-hidden="true">
                {session.username.slice(0, 1).toUpperCase()}
              </span>
              <span className="account-name" title={session.username}>
                {session.username}
              </span>
              <Button
                type="text"
                aria-label="退出登录"
                title="退出登录"
                icon={<WorkspaceIcon name="logout" />}
                onClick={onLogout}
                loading={loggingOut}
              />
            </div>
          </div>
        </header>
        <div className="workspace-content">
          <main id="main" tabIndex={-1}>
            {children}
          </main>
          <footer className="workspace-footer">
            <span>WebPulse · 数据自持，指标透明。</span>
            <a
              href="/sites"
              onClick={(event) => {
                event.preventDefault();
                navigate('/sites');
              }}
            >
              管理站点
            </a>
          </footer>
        </div>
      </div>
    </div>
  );
}
