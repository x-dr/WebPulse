# Tracker

当前只建立无框架 TypeScript → esbuild IIFE 的构建入口，产物为 `dist/tracker.js`。
它仅暴露 `WebPulse.status = 'not_implemented'` 与版本，不读取存储、不安装事件监听器、不发请求。

M1 将实现同意/退出、路由判重、URL 清洗、幂等上报和心跳。此前不能将此产物当作可用采集 SDK 接入网站。
