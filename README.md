# GitHub Desktop

这是 [desktop/desktop](https://github.com/desktop/desktop) 的分支。日常改代码可以留在同一个窗口里：提交图、文件树、编辑器、终端和 Copilot 代理。

This is a fork of [desktop/desktop](https://github.com/desktop/desktop). Day-to-day editing stays in one window: the commit graph, file tree, editor, terminal, and Copilot agent.

## 下载 | Download

macOS 和 Windows 安装包在 [Releases](https://github.com/coolzoom/githubdesktop/releases)。推送到 `development` 后，GitHub Actions 会编译并发布新版本。

macOS and Windows installers are on [Releases](https://github.com/coolzoom/githubdesktop/releases). A push to `development` builds them and publishes a new version.

- macOS：下载 `GitHub Desktop-arm64.zip` 或 `GitHub Desktop-x64.zip`，解压后把 GitHub Desktop.app 放进“应用程序”。
- macOS: download `GitHub Desktop-arm64.zip` or `GitHub Desktop-x64.zip`, unzip it, and move GitHub Desktop.app into Applications.
- Windows：运行 `GitHubDesktopSetup-x64.exe` 或 `GitHubDesktopSetup-arm64.exe`。
- Windows: run `GitHubDesktopSetup-x64.exe` or `GitHubDesktopSetup-arm64.exe`.

开发版和安装版启动时都会检查这个仓库的最新 Release，之后每 4 小时再查一次。有更新时窗口顶部会出现提示，可下载对应平台的安装包。当前代码如果就是该 Release 的同一次提交，则不会提示。

Dev builds and installed builds both check this repository's latest Release at startup, then again every 4 hours. A newer release shows a banner with a download for the current platform. A build of the same commit as that Release does not prompt.

这些安装包没有 Apple 或 Azure 签名。macOS 第一次打开时，在 Finder 里对应用点右键，选择“打开”。

The installers are not signed with Apple or Azure certificates. The first time you open the macOS app, right-click it in Finder and choose Open.

## 提交图 | Commit graph

History 默认是提交图。分支和标签画在图上，正在修改的文件显示为 `// WIP`。可以搜索提交、按日期或拓扑排序，并从右键菜单检出、打标签。分支没有上游或领先远程时，菜单里有 Force Push。

History opens on the commit graph. Branches and tags are drawn on the graph, and uncommitted work appears as `// WIP`. Search commits, sort by date or topology, and check out or tag from the context menu. Force Push is available when the branch has no upstream or is ahead of the remote.

![提交图，左侧是分支和标签，中间是历史，右侧是这次提交的文件，底部是终端。Commit graph with branches, history, changed files, and the terminal.](docs/images/history-graph.png)

## 文件树 | File tree

左侧活动栏在文件树、分支 / 标签 / 储藏、Copilot 之间切换。改过的文件旁边有圆点。点一个文件会在编辑器里打开。

The activity bar switches between the file tree, branches / tags / stashes, and Copilot. Changed files have a dot. Clicking a file opens it in the editor.

![仓库文件树，已修改的目录带有圆点。File tree with dots on changed directories.](docs/images/file-explorer.png)

## 编辑器 | Editor

编辑器使用 Monaco，可以同时打开多个文件。Edit 打开编辑，Save 写回工作区。右侧是这个文件相对当前版本的改动。

The editor is Monaco and can keep several files open. Edit turns on editing, and Save writes the file back to the working tree. The gutter on the right shows how the file differs from the current revision.

![README.md 打开在内置编辑器中，右侧是改动缩略图。README.md open in the built-in editor with a change overview.](docs/images/code-editor.png)

## 差异 | Diff

在一次提交里点文件，会看到带语法高亮的差异。也可以切回经典差异。

Click a file in a commit to see a syntax-highlighted diff. The classic diff is still available.

![desktop.cmd 的新增行差异。Added lines in the desktop.cmd diff.](docs/images/git-diff.png)

## 终端 | Terminal

提交图和编辑器下面可以打开当前仓库的终端，快捷键是 Ctrl+`。可以清屏、重启 shell，或把终端收起来。

A terminal for the current repository docks under the graph and the editor. The shortcut is Ctrl+`. Clear the screen, restart the shell, or hide the terminal.

![停靠在提交图下方的终端。Terminal docked under the commit graph.](docs/images/terminal.png)

## Copilot

Copilot Agent 可以读这个仓库、改文件、运行命令。改动和命令会先征求同意。聊天可以新建、切换和删除。

The Copilot agent can read this repository, edit files, and run commands. Edits and commands ask for approval first. Chats can be created, switched, and deleted.

![Copilot 代理侧栏和输入框。Copilot agent sidebar and composer.](docs/images/copilot-agent.png)

## 从源码构建 | Build from source

环境准备见 [`docs/contributing/setup.md`](docs/contributing/setup.md)。

Setup is documented in [`docs/contributing/setup.md`](docs/contributing/setup.md).

## 许可证 | License

**[MIT](LICENSE)**

MIT 许可不包括 GitHub 的商标。GitHub 保留其商标和标识的全部权利，包括 [logos](app/static/logos) 目录里带 “logo” 的 Invertocat 图案。使用这些标识时请遵守 GitHub 的 [logo guidelines](https://github.com/logos)。

The MIT license does not grant rights to GitHub's trademarks. GitHub reserves all trademark and copyright rights in its marks, including the Invertocat designs whose file names include "logo" in [logos](app/static/logos). Follow the GitHub [logo guidelines](https://github.com/logos) when using them.
