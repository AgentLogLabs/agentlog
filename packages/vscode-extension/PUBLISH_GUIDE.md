# AgentLog VS Code 插件发布指南

## 发布前检查清单

### ✅ 已完成的项目
1. **环境准备**：Node.js v22.22.0、pnpm@9.15.9、vsce@3.7.1 已安装
2. **代码修改**：
   - `package.json`：`"private": false`、`"publisher": "agentloglabs"`
   - 创建 `.vscodeignore`：排除开发文件，包体积从 10MB → 1.5MB
   - 创建 `CHANGELOG.md`：v0.1.0 发布说明
   - 创建 `RELEASE_NOTES.md`：详细发布说明文档
3. **构建验证**：
   - 依赖安装完成（`pnpm install`）
   - 所有包构建成功（`pnpm build`：shared → backend → vscode-extension）
   - 测试基本通过（backend 集成测试 + fetch 拦截测试）
4. **打包测试**：
   - 生成 `.vsix` 文件：`agentlog-vscode-0.1.0.vsix`（1.5 MB）
   - 包内容验证：包含 extension.js、backend 服务、webview 资源

## 发布前待办事项

### 1. 图标准备（当前暂停点）
当前图标文件：
- `assets/sidebar-icon.svg`：SVG 矢量图标（文档+AI点设计）
- `assets/sidebar-icon2.png`：PNG 位图图标（当前 package.json 使用）

**如需替换图标**：
1. 准备新图标文件（建议尺寸：128×128 PNG，同时提供 SVG 版本）
2. 替换 `assets/sidebar-icon.svg` 和 `assets/sidebar-icon2.png`
3. 确保文件名一致，或更新 package.json 中图标引用：
   ```json
   "icon": "assets/your-new-icon.png"
   ```

**图标要求**：
- 清晰可识别，体现 AI 日志记录概念
- 建议使用明亮色彩，在 VS Code 深色/浅色主题下都清晰
- 符合 VS Code 扩展图标设计规范

### 2. 注册发布者账户（需要你手动操作）
**步骤**：
1. **访问发布者管理页面**：
   - https://marketplace.visualstudio.com/manage
   - 使用 Microsoft 账户登录（建议使用与 GitHub 关联的账户）

2. **创建发布者**：
   - 点击 "Create Publisher"
   - 输入信息：
     - **Publisher ID**: `agentloglabs`（必须与 package.json 中的 `"publisher"` 一致）
     - **Publisher Name**: `AgentLog Labs`（显示名称，可自定义）
     - **Description**: 简短描述，如 "Tools for AI-powered development"
     - **Website**: `https://github.com/agentlog/agentlog`
     - **Support**: GitHub Issues URL

3. **获取 Personal Access Token (PAT)**：
   - 在发布者页面，点击 "Personal Access Tokens"
   - 创建新 Token，选择 "All accessible organizations"，有效期建议 1 年
   - 复制 Token（仅显示一次，妥善保存）

### 3. 发布流程（图标准备好后执行）

**A. 登录 vsce**：
```bash
cd packages/vscode-extension
vsce login agentloglabs
# 输入刚才获取的 PAT
```

**B. 发布扩展**：
```bash
vsce publish
# 或指定版本：vsce publish 0.1.0
```

**C. 验证发布**：
1. 访问扩展页面：https://marketplace.visualstudio.com/items?itemName=agentloglabs.agentlog-vscode
2. 检查信息是否正确显示
3. 测试安装：`code --install-extension agentloglabs.agentlog-vscode`

**D. 可选：发布到 Open VSX Registry**（供 Cursor 等使用）：
```bash
npm install -g ovsx
ovsx publish agentlog-vscode-0.1.0.vsix -p <your-pat>
```

## 发布后验证

### 功能验证清单
1. **安装测试**：
   - 在干净的 VS Code/Cursor 环境中安装扩展
   - 验证侧边栏 "AgentLog" 面板正常显示
   - 后台服务自动启动（端口 7892）

2. **核心功能测试**：
   - 使用 Cline/Cursor 进行 AI 对话，验证自动捕获
   - 执行 `git commit`，验证自动绑定
   - 测试导出功能：周报、PR 说明
   - 测试 Commit 上下文生成

3. **配置验证**：
   - VS Code 设置中的 AgentLog 配置项正常显示
   - 修改配置（如 backendUrl）生效

## 常见问题与解决方案

### Q1: 发布时遇到 "Publisher not found" 错误
**原因**：未正确创建发布者账户或 publisher ID 不匹配
**解决**：
1. 确认在 https://marketplace.visualstudio.com/manage 创建了 `agentloglabs` 发布者
2. 确认 package.json 中 `"publisher": "agentloglabs"` 完全一致
3. 使用 `vsce login agentloglabs` 重新登录

### Q2: 包体积过大导致发布失败
**当前状态**：1.5 MB（已优化）
**如果仍需优化**：
1. 检查 `.vscodeignore` 是否排除了所有开发文件
2. 可进一步排除 `dist/backend/node_modules` 中非必要的依赖

### Q3: 扩展安装后无法启动后台服务
**可能原因**：better-sqlite3 编译问题
**解决**：
1. 确保用户环境有 Node.js ≥ 18
2. 可能需要安装编译工具（Python、Xcode Command Line Tools）
3. 或提供预编译的二进制文件

### Q4: 图标显示问题
**解决**：
1. 确保图标文件在 `assets/` 目录下
2. 检查 package.json 中图标路径引用
3. 图标尺寸建议：128×128 PNG，透明背景

## 后续版本更新流程

### 版本号规范
- `MAJOR.MINOR.PATCH`（语义化版本）
- 示例：`0.1.0` → `0.1.1`（小修复）→ `0.2.0`（新功能）

### 更新步骤
1. **更新版本号**：`package.json` 中的 `"version"`
2. **更新 CHANGELOG**：添加新版本变更记录
3. **构建测试**：`pnpm build` + `pnpm test`
4. **打包**：`pnpm package`（生成新 .vsix）
5. **发布**：`vsce publish`

## 资源与支持
- **项目仓库**：https://github.com/agentlog/agentlog
- **VS Code 扩展开发文档**：https://code.visualstudio.com/api
- **Marketplace 发布文档**：https://code.visualstudio.com/api/working-with-extensions/publishing-extension
- **问题反馈**：GitHub Issues

---

**准备好图标后，执行以下命令完成发布**：
```bash
cd /Users/hobo/Projects/AgentLog/packages/vscode-extension
vsce login agentloglabs
vsce publish
```