; =====================================================================
; OmniFingerprint PUP Server - Inno Setup Script
; 生成带向导的安装包（不包含敏感数据/浏览器配置文件）
; =====================================================================

#define MyAppName          "OmniFingerprint PUP Server"
#define MyAppVersion       "2.4.0"
#define MyAppPublisher     "OmniFingerprint"
#define MyAppExeName       "pup-server.exe"
#define MyAppStartName     "start.bat"

[Setup]
AppId={{B8F3A7C2-9D5E-4A1F-8B6C-3E2D9F7A1C4E}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppVerName={#MyAppName} {#MyAppVersion}
DefaultDirName={commonpf}\OmniFingerprint\PUPServer
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=installer-output
OutputBaseFilename=pup-server-setup-{#MyAppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
WizardStyle=modern
UninstallDisplayIcon={app}\{#MyAppExeName}
PrivilegesRequired=admin
DisableDirPage=no

; 不创建任何注册表自动启动项（用户手动点快捷方式启动）
; 卸载时询问是否保留用户数据
Uninstallable=yes
CreateUninstallRegKey=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "在桌面创建快捷方式"; GroupDescription: "附加任务:"; Flags: checkedonce
Name: "startupicon"; Description: "开机自启动（不推荐，建议手动启动）"; GroupDescription: "附加任务:"; Flags: unchecked

[Dirs]
; 预创建运行时目录（空），不包含任何数据
Name: "{app}\logs"; Permissions: users-modify
Name: "{app}\data"; Permissions: users-modify
Name: "{app}\browser-profiles"; Permissions: users-modify

[Files]
; 主程序 exe（内置 Node 22 + 服务器代码 + 依赖）
Source: "pup-client\pup-server.exe"; DestDir: "{app}"; Flags: ignoreversion
; 启动脚本
Source: "pup-client\start.bat"; DestDir: "{app}"; Flags: ignoreversion
; 运行时配置（数据同步目标 STORAGE_SERVER_URL，不含敏感信息）
Source: "pup-client\.env"; DestDir: "{app}"; Flags: ignoreversion
; sqlite3 native 模块（运行时提取的二进制）
Source: "pup-client\resources\*"; DestDir: "{app}\resources"; Flags: ignoreversion recursesubdirs createallsubdirs
; 内置 Chrome 142 浏览器
Source: "pup-client\bundled-chrome\*"; DestDir: "{app}\bundled-chrome"; Flags: ignoreversion recursesubdirs createallsubdirs

; ⚠️ 明确不包含以下内容（防止数据泄露）：
; - browser-profiles/  （浏览器登录态、cookies）
; - data/              （业务数据库 omnifingerprint.db）
; - logs/              （运行时日志，可能含敏感信息）
; - profiles.db        （本地 profile 配置数据库）

[Icons]
; 开始菜单快捷方式
Name: "{group}\启动 PUP 服务器"; Filename: "{app}\{#MyAppStartName}"; WorkingDir: "{app}"; Comment: "启动 OmniFingerprint PUP 服务器 (端口 9999)"; IconFilename: "{app}\{#MyAppExeName}"
Name: "{group}\卸载 PUP 服务器"; Filename: "{uninstallexe}"; Comment: "卸载 OmniFingerprint PUP 服务器"

; 桌面快捷方式（可选）
Name: "{commondesktop}\启动 PUP 服务器"; Filename: "{app}\{#MyAppStartName}"; WorkingDir: "{app}"; Tasks: desktopicon; IconFilename: "{app}\{#MyAppExeName}"

; 开机自启（可选）
Name: "{commonstartup}\启动 PUP 服务器"; Filename: "{app}\{#MyAppStartName}"; WorkingDir: "{app}"; Tasks: startupicon; IconFilename: "{app}\{#MyAppExeName}"

[Run]
; 安装完成后可选立即启动
Filename: "{app}\{#MyAppStartName}"; Description: "立即启动 PUP 服务器"; Flags: nowait postinstall skipifsilent unchecked; WorkingDir: "{app}"

[UninstallRun]
; 卸载前先停止 pup-server.exe（避免文件占用）
Filename: "{cmd}"; Parameters: "/C taskkill /F /IM pup-server.exe /T 2>nul & taskkill /F /IM chrome.exe /T 2>nul"; Flags: runhidden; RunOnceId: "KillProcess"

[UninstallDelete]
; 卸载时清理运行时生成的文件（保留用户数据可选）
Type: filesandordirs; Name: "{app}\logs"
Type: filesandordirs; Name: "{app}\resources"

[Code]
// 卸载时询问是否保留用户数据
function InitializeUninstall(): Boolean;
begin
  Result := True;
end;

// 卸载完成后询问是否删除用户数据
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
  begin
    if MsgBox('是否同时删除用户数据（数据库、浏览器配置、日志）？'#13#10#13#10'选择"是"将完全清除所有数据，选择"否"将保留数据以便重装后恢复。', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
    begin
      DelTree(ExpandConstant('{app}\data'), True, True, True);
      DelTree(ExpandConstant('{app}\browser-profiles'), True, True, True);
      DelTree(ExpandConstant('{app}'), True, True, True);
    end;
  end;
end;

// 安装前检查：如果是升级安装，先停止运行中的进程
function InitializeSetup(): Boolean;
var
  ResultCode: Integer;
begin
  // 尝试停止可能正在运行的旧版本
  Exec(ExpandConstant('{cmd}'), '/C taskkill /F /IM pup-server.exe /T 2>nul', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := True;
end;
