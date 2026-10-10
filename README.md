# DSH Tavern Image

给 DSH Tavern 的聊天正文配图。自动模式会让规划模型挑出值得画的场景，生图在后台进行；想补图时，也可以直接在回复下手动生成。

## 从旧版本升级

原插件目录叫 `dsh-tavern-comfy`。插件内的更新入口从 **1.2.1** 开始提供；1.2.0 及更早版本没有这个入口，需要先手动更新。

1.2.1 及之后的版本可以在 **设置 → 本地生图 → 插件更新** 检查并安装。更新前，先确认 tools 目录里没有另一个 `dsh-tavern-image` 文件夹。代码更新完成后，完整退出 DSH Desktop（包括托盘中的进程），再到下面的目录把 `dsh-tavern-comfy` 文件夹改名为 `dsh-tavern-image`，然后重新打开 DSH：

~~~text
%USERPROFILE%\.dsh\profile-data\tavern\data\tools
~~~

1.2.0 及更早版本如果是 Git 克隆安装，可以先备份插件文件夹并退出 DSH。确认当前分支是 `master`、没有要保留的本地代码修改后，在 PowerShell 运行：

~~~powershell
cd "$env:USERPROFILE\.dsh\profile-data\tavern\data\tools\dsh-tavern-comfy"
git remote set-url origin https://github.com/weixinlll/dsh-tavern-image.git
git pull --ff-only origin master
~~~

旧版更新器只会更新代码，不会移动插件文件夹。改名要在 DSH 完全退出后进行；运行中改名会影响页面资源和数据读写。配置、人物资料、工作流、缓存和历史记录都在这个文件夹里，整目录改名会一起保留。若新旧两个目录都已存在，先备份并确认要保留的数据，不要直接合并或覆盖。

## 新安装

在 DSH 的 tools 目录运行：

~~~powershell
cd "$env:USERPROFILE\.dsh\profile-data\tavern\data\tools"
git clone https://github.com/weixinlll/dsh-tavern-image.git
~~~

安装后完整退出并重新打开 DSH Desktop。

## 配图

打开 **设置 → 本地生图**。开启自动配图后，新回复结算时由规划模型判断哪些场景值得单独成图；没有合适场景时可以跳过。选中的图片会在后台生成，完成后插入对应消息。手动生成不受自动判断影响。

图片关联到生成它的正文版本。切换回复版本时，只显示该版本的图片。生图请求遇到网络错误时不会自动重试；如果服务端已接收任务但响应丢失，先查看任务记录，再决定是否手动重试。

## 生图渠道

可用 ComfyUI、NovelAI、OpenAI Images、Gemini、Grok、Seedream、Qwen-Image、Stable Diffusion WebUI / Forge，以及兼容这些接口的服务。每个渠道可以单独设置地址、模型和 API Key；网页登录状态不能代替 API Key。

ComfyUI 的简单模式可以直接选模型和常用参数。需要控制节点时，切到工作流模式并导入 API 格式的 JSON；插件会显示节点与连接，也可以编辑识别出的常用参数。

规划模型负责判断场景和整理提示词，可以单独选择；留空时使用 DSH 配置的后台模型。ComfyUI 必须能从运行 DSH 的设备访问。远程服务会收到提示词和生图请求，部分渠道按量计费。

## 人物和画风

人物库可以记录外貌、服装和角色绑定。角色较多时可以折叠列表、单独编辑，也可以批量修改选中的角色。剧情确认了长期外貌变化后，可以保存到角色历史；历史按正文版本记录，便于查看和恢复。

画风预设和提示词预设可以按渠道使用，也可以自己添加正面、负面提示词。NovelAI 使用标签提示词；OpenAI Images、Gemini 等渠道使用自然语言提示词。开启 PNG 转 JPEG 可以减少图片文件体积。

## 更新与数据

插件内更新只支持官方 Git 仓库的 `master` 分支。存在本地代码修改、提交分叉、目标目录冲突，或更新内容涉及用户数据文件时，更新器会停止。更新后需要重启 DSH。

密钥、人物资料、世界书、工作流和图片缓存保存在插件文件夹中。远程渠道的费用与数据处理方式以服务商说明为准。

当前版本：**2.1.0**。兼容 DSH `>=0.1.0-rc.8 <0.2.0`。
