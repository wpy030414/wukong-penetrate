# 使用 CC Switch GUI 配置本项目

[CC Switch](https://github.com/farion1231/cc-switch) 是一个 Claude Code 配置管理工具，提供了图形化界面来管理 Claude Code 的各项设置。通过 CC Switch，你可以更方便地配置本项目与 Claude Code 的集成。

## 前置要求

- 已安装 CC Switch
- 已安装本项目的依赖（`pnpm install`）
- 已获取 `DEAP_API_KEY`（运行 `pnpm capture-key`）

## 配置步骤

### 1. 启动代理服务

首先确保代理服务正在运行：

```bash
pnpm serve
```

服务默认运行在 `http://localhost:8000`。

### 2. 在 CC Switch 中添加新的 API 端点

在 CC Switch 中：

1. **增加新的自定义配置供应商**
2. **填写以下信息**：
   - **供应商名称**: `Wukong Anthropic Proxy`
   - **请求地址**: `http://localhost:8000`
   - **API Key**: （随便填，除非你在 `.env` 中设置了 `API_KEY`）
   - **模型名称**: `dingtalk-auto`

3. **保存配置**

## 使用效果

配置完成后，Claude Code 的所有 API 调用都会通过本代理转发到钉钉悟空模型：

- **零代码修改**：Claude Code 无需任何改动
- **完整功能支持**：包括 tools / function calling
- **流式响应**：支持 SSE 流式输出
- **Prompt Caching**：协议层面完全支持透传

## 常见问题

### Q：如何切换回官方 Anthropic API？

A：在 CC Switch 中选择其他配置即可，随时切换。

### Q：代理端口不是 8000 怎么办？

A：在 `.env` 中修改 `PORT` 环境变量，然后在 CC Switch 中更新 Base URL。

### Q：需要认证怎么办？

A：如果在 `.env` 中设置了 `API_KEY`，在 CC Switch 的 API Key 字段填入对应的值。

## 相关文档

- [CC Switch 官方文档](https://github.com/rua-project/cc-switch)
- [CAPTURE_DEAP_KEY.md](./CAPTURE_DEAP_KEY.md) - 如何获取 DEAP_API_KEY
- [README.md](../README.md) - 项目主文档
