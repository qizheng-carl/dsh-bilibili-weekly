# dsh-bilibili-weekly

DeepSeek Harness 插件：读取 B 站[「每周必看」榜单](https://www.bilibili.com/v/popular/weekly)，生成一页 Markdown 周报，并在 Web 端右侧常驻一个周报面板。

> 当前版本：`0.1.0` · 无运行时依赖（只用 Node 内置模块）· MIT

## 安装

在 DeepSeek Harness 里用插件管理器安装本 bundle，二选一：

```text
plugin_manager  action: install_bundle   target: dsh-bilibili-weekly
plugin_manager  action: install_bundle   target: github:Carlapple2025-gif/dsh-bilibili-weekly
```

第一条从 npm 装，第二条从 GitHub 装。两条都已实测可用。

- npm: https://www.npmjs.com/package/dsh-bilibili-weekly
- GitHub: https://github.com/Carlapple2025-gif/dsh-bilibili-weekly

装完即可在 Plugins 页看到「B站每周必看 · 周报」，Web 端右下方出现周报面板。

## 数据来源

| 用途 | 接口 |
| --- | --- |
| 期数列表 | `app.bilibili.com/x/v2/show/popular/selected/series?type=weekly_selected` |
| 某期榜单 | `app.bilibili.com/x/v2/show/popular/selected?type=weekly_selected&number=<期号>` |
| 单条视频详情 | `api.bilibili.com/x/web-interface/view?bvid=<BV号>` |

页面 Web 接口 `api.bilibili.com/x/web-interface/popular/series/one` 对匿名非浏览器客户端返回 `-352`（风控），因此主路径走 App 接口；同时保留 wbi 签名调用 Web 接口作为兜底。

## 提供的能力

- **工具 `bilibili_weekly`**（Agent 可调用）
  - `action: list` —— 期数列表
  - `action: latest` —— 最新一期概览（主题、周期、播放/时长/分区/UP 主 + TOP10）
  - `action: week` + `number` —— 指定期数
  - `action: report` + `outputPath` —— 生成 Markdown 周报并落盘，返回文件路径与正文。
    绝对路径原样写入；相对路径写入插件的 reports 目录（`~/.dsh/bilibili-weekly/reports`）。
    返回值里同时带完整 `markdown`，需要放到工作区时由 Agent 用 `write` 落盘即可。
- **技能 `bilibili-weekly`** —— 告诉 Agent 什么时候、怎么用这个工具。
- **Web 面板**（`shell.overlay`）—— 期数切换、封面列表、数据概览、一键生成周报、复制周报。

## 配置

`cordis.patch.yml` 里可调：

```yaml
- insert:
    - id: bilibili-weekly
      name: 'dsh-bilibili-weekly'
      config:
        topN: 10            # 榜单展示条数
        enrich: true        # 是否补抓每条视频详情（播放/点赞/投币/收藏/弹幕）
        enablePanel: true   # 是否挂载 Web 面板
```

其余可选项：`dataDir`（默认 `~/.dsh/bilibili-weekly`）、`reportDir`（默认 `<dataDir>/reports`）、`maxEnrich`（默认 60）、`enrichConcurrency`（默认 4）、`cacheMinutes`（默认 30）、`timeoutMs`（默认 12000）。

## 缓存

数据缓存在 `~/.dsh/bilibili-weekly/cache.json`，默认 30 分钟内复用；`refresh: true`（工具入参）或面板的刷新按钮会跳过缓存。

## 周报结构

1. 本周概览（播放/时长/互动/UP 主/分区）
2. 榜单 TOP N（官方排序）
3. 播放量 TOP 10（按播放重排）
4. 分区分布（含二级分区细分）
5. UP 主上榜统计
6. 数据亮点（播放/点赞/弹幕/互动率/最长最短）
7. 观看建议（碎片时间、长视频、排名外黑马）
8. 附：完整榜单


## 卸载

```text
plugin_manager  action: remove_bundle   target: dsh-bilibili-weekly
```

缓存与已生成的周报在 `~/.dsh/bilibili-weekly/`，卸载后需要手动删除（或保留作为历史数据）。

## 已知限制

- 依赖 B 站公开接口，接口或其风控策略变化时可能需要更新版本。
- 面板只在 Harness Web UI 内渲染；纯本地 CLI 场景下用工具 `bilibili_weekly` 即可。
- 周报里的「分区」来自视频详情接口的二级分区名，再归并到一级分组；未识别的分区归入「其他」。

## License

MIT
