# 小红书采集 · 飞书上传

Windows 桌面工具：采集小红书笔记信息，按分组整理后写入飞书多维表格，并支持批量上传本地图片到附件字段。

## 重装系统后恢复

### 方法一：直接下载 GitHub 自动构建的软件

1. 打开本仓库的 **Actions** 页面。
2. 选择最新一次 **Build Windows desktop app** 构建。
3. 在页面底部下载 `xiaohongshu-feishu-uploader-windows`。
4. 解压后运行其中的便携版 `.exe`。

### 方法二：从源码运行

1. 安装 [Node.js](https://nodejs.org/) 20 或更高版本。
2. 在 GitHub 仓库页面点击 **Code → Download ZIP**，下载并解压。
3. 在项目目录打开 PowerShell，依次运行：

```powershell
npm install
npm start
```

### 自己生成便携版

```powershell
npm install
npm run dist
```

生成的程序位于 `dist` 目录。

## 重装后需要重新配置的内容

- 飞书授权码需要重新填写。授权码由 Windows 安全存储加密，旧系统中的密文不能在新系统解密。
- 飞书多维表格链接需要重新确认。
- 图片文件夹路径需要按新电脑的实际目录重新选择。
- 分组与发布账号可在“分组配置”中重新设置，保存后会在本机自动持久化。

## 隐私说明

仓库只保存程序源码，不上传授权码、本机配置、图片文件夹内容、`node_modules` 或构建缓存。

