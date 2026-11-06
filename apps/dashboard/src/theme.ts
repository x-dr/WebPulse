import type { ThemeConfig } from 'antd';

export const theme: ThemeConfig = {
  token: {
    colorPrimary: '#264C3B',
    colorLink: '#35614C',
    colorLinkHover: '#1D3D2E',
    colorBgLayout: '#F5F7FA',
    colorBgContainer: '#FFFFFF',
    colorBgElevated: '#FFFFFF',
    colorText: '#263D32',
    colorTextSecondary: '#65716A',
    colorBorder: '#DEE3E8',
    colorBorderSecondary: '#E9EDF1',
    borderRadius: 8,
    fontSize: 14,
    controlHeight: 44,
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
    motion: false,
  },
  components: {
    Button: { defaultShadow: 'none', primaryShadow: 'none' },
  },
};
