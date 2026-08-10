# 迅雷 C++ SDK 接入

项目已经保留 `LocalXunleiAdapter` 作为下载边界，并新增了可选的原生宿主：

```text
Renderer → preload IPC → Electron Main → xunlei-download-host → dk.dll
```

默认仍使用现有的受控 HTTP 下载。只有在主进程环境中设置
`XL_AGENT_XUNLEI_ENABLED=1`，且存在 API Key 和已经编译的原生宿主时，才会使用
迅雷 SDK。

## 本地配置

不要把 API Key 写入源码或提交到 Git。在项目根目录的 `.env` 中追加：

```env
XL_AGENT_XUNLEI_ENABLED=1
XL_AGENT_XUNLEI_APP_ID=your-app-id
XL_AGENT_XUNLEI_API_KEY=your-api-key
# 可选；不设置时使用开发目录下的默认路径
# XL_AGENT_XUNLEI_HOST_PATH=/absolute/path/to/xunlei-download-host.exe
```

SDK 配置和下载临时文件会写到 Electron 的 `userData` 目录，不写入 ASAR。

## 编译原生宿主

SDK 位于项目根目录的 `xunlei-dlsdk-cpp/xunlei-dlsdk-cpp/`。Windows x64 构建需要
Windows x64 的 C++ 工具链：

```powershell
cmake -S xunlei-dlsdk-cpp/xunlei-dlsdk-cpp `
  -B sdk-build-win-x64 `
  -DXL_DL_CPP_NATIVE_PLATFORM=windows-x64 `
  -DCMAKE_INSTALL_PREFIX=$pwd/sdk-install
cmake --install sdk-build-win-x64 --config Release

cmake -S native/xunlei-download-host `
  -B native-build-win-x64 `
  -DCMAKE_PREFIX_PATH=$pwd/sdk-install
cmake --build native-build-win-x64 --config Release
```

将生成的 `xunlei-download-host.exe` 和 SDK 的 `dk.dll` 放到：

```text
native/xunlei-download-host/dist/windows-x64/
```

`electron-builder` 会把这两个文件复制到安装包的
`resources/xunlei-sdk/`。当前 macOS 开发机没有 CMake，不能在本机验证 Windows
原生链接；应在 Windows 或 Windows CI 上完成这一步。

## 运行顺序

原生宿主启动后执行 `xl_dl_init`、获取登录 Token、`xl_dl_login`，然后接收下载
命令并调用 `xl_dl_create_p2sp_task`、`xl_dl_start_task`，轮询
`xl_dl_get_task_state`，完成后由 Electron Main 再次校验文件大小、SHA256 和
lockfile SHA512。

