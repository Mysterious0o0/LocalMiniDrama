# FFmpeg 本地目录

将 ffmpeg 可执行文件放在此目录下，后端会优先使用，**无需配置环境变量**。

## 需要拷贝的文件（Windows）

- `ffmpeg.exe`
- `ffprobe.exe`（若需要探测时长等信息）

从 FFmpeg 官方构建目录的 `bin` 下复制到本目录即可。

## 一键拷贝（可选）

若你的 ffmpeg 在 `D:\Program Files\ffmpeg-8.0.1-essentials_build\bin`，可在 **backend-node** 目录下执行：

```bash
node scripts/copy-ffmpeg.js "D:\Program Files\ffmpeg-8.0.1-essentials_build\bin"
```

会复制 `ffmpeg.exe` 和 `ffprobe.exe` 到本目录。

## 路径优先级

1. 本目录下的 `ffmpeg`（或 Windows 下 `ffmpeg.exe`）
2. 环境变量 `FFMPEG_PATH`（若已设置）
3. 系统 PATH 中的 `ffmpeg`



## 下载ffmpeg 并保存到tools下(linux版)
要在任意 Linux 目录下直接运行而不依赖系统环境，你需要下载 **Static Build**。

1.  **删除当前目录下的“假”文件：**
    ```bash
    rm ffmpeg ffprobe
    ```

2.  **下载 Linux 64位 静态包（推荐 John Van Sickle 的构建版本）：**
    ```bash
    # 下载 6.1 或 7.x 稳定版
    wget https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
    ```

3.  **解压并拷贝：**
    ```bash
    # 解压
    tar -xvf ffmpeg-release-amd64-static.tar.xz
    
    # 进入解压后的目录（文件夹名根据版本可能略有不同）
    cd ffmpeg-7.1-amd64-static/
    
    # 将真正的“大”文件拷贝回你的目录
    mv ffmpeg-7.1-amd64-static /LocalMiniDrama/backend-node/tools/ffmpeg
    ```

4.  **验证：**
    再次执行 `ll`，你应该看到 `ffmpeg` 的大小变成了 **70MB ~ 150MB** 左右。此时再运行 `./ffmpeg -version`，你会发现 configuration 里显示的是 `---enable-static`。
