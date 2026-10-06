; OmniFingerprint PUP Server Windows Installer
; 使用 Inno Setup 编译（https://jrsoftware.org/isdl.php）
; 编译命令: ISCC.exe pup-installer.iss

#define MyAppName "OmniFingerprint PUP Server"
#define MyAppVersion "2.6.1"
#define MyAppPublisher "OmniFingerprint"
#define MyAppURL "https://your-project.pages.dev"
#define MyAppExeName "pup-server.exe"
#define MyAppBatName "start-pup.bat"

[Setup]
AppId={{B8F4A3D1-2C5E-4A7B-9F6D-8E1C3A5B7D9F}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\OmniFingerprint\PUP-Server
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
OutputDir=..\installer-output
; 🏷️ 输出文件名带版本号（如 pup-server-setup-2.5.0.exe），与历史产物命名一致
OutputBaseFilename=pup-server-setup-{#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
DisableProgramGroupPage=yes
; 安装包图标（如果需要请替换）
; SetupIconFile=..\public\favicon.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
; 注：当前 Inno Setup 安装未包含简体中文语言包
; Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "快捷方式："; Flags: checkedonce

; ========== 文件列表 ==========
[Files]
; pkg 编译产物（核心 exe）
Source: "..\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
; 启动脚本
Source: "..\start-pup.bat"; DestDir: "{app}"; Flags: ignoreversion
; 捆绑的 Chromium 浏览器（安装目录约 412MB）——bundled-chrome 目录存在时才打包（缺失时编译报错，2026-09-28 已删目录）
#if DirExists("..\bundled-chrome")
Source: "..\bundled-chrome\*"; DestDir: "{app}\bundled-chrome"; Flags: ignoreversion recursesubdirs createallsubdirs
#endif

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppBatName}"; WorkingDir: "{app}"
Name: "{group}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppBatName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
; 安装完成后可选启动
Filename: "{app}\{#MyAppBatName}"; Description: "启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent shellexec

; ========== 安装前检查 ==========
[Code]
var
  ChromePath: string;
  UseBundledChrome: Boolean;

{-- 获取架构标签 --}
function GetArch(Param: string): string;
begin
  if Is64BitInstallMode then
    Result := 'x64'
  else
    Result := 'x86';
end;

{-- 检测 Chrome 安装路径 --}
function FindChrome(): string;
var
  Paths: array[0..7] of string;
  I: Integer;
begin
  Result := '';
  Paths[0] := ExpandConstant('{pf64}\Google\Chrome\Application\chrome.exe');
  Paths[1] := ExpandConstant('{pf32}\Google\Chrome\Application\chrome.exe');
  Paths[2] := ExpandConstant('{pf64}\Microsoft\Edge\Application\msedge.exe');
  Paths[3] := ExpandConstant('{pf32}\Microsoft\Edge\Application\msedge.exe');
  Paths[4] := ExpandConstant('{localappdata}\Google\Chrome\Application\chrome.exe');
  Paths[5] := ExpandConstant('{localappdata}\Microsoft\Edge\Application\msedge.exe');
  Paths[6] := ExpandConstant('{localappdata}\Chromium\Application\chrome.exe');
  Paths[7] := 'D:\omnibrowser\browsers\chrome\chrome.exe';

  for I := 0 to 7 do
  begin
    if FileExists(Paths[I]) then
    begin
      Result := Paths[I];
      Exit;
    end;
  end;
end;

{-- 安装前检测 Chrome --}
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  ChromePath := FindChrome();

  if ChromePath = '' then
  begin
    if MsgBox(
      '未检测到 Chrome 或 Edge 浏览器。' + Chr(13) + Chr(10) +
      Chr(13) + Chr(10) +
      'PUP Server 需要 Chromium 内核浏览器才能运行。' + Chr(13) + Chr(10) +
      '您可以选择继续安装（稍后手动安装浏览器），或取消安装。' + Chr(13) + Chr(10) +
      Chr(13) + Chr(10) +
      '是否继续安装？',
      mbConfirmation,
      MB_YESNO
    ) = IDNO then
    begin
      Result := '用户取消了安装（缺少浏览器）';
    end;
  end;
end;

{-- 安装完成后的提示 --}
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    if ChromePath = '' then
    begin
      MsgBox(
        '重要提示：' + Chr(13) + Chr(10) +
        Chr(13) + Chr(10) +
        '未检测到 Chrome/Edge 浏览器。' + Chr(13) + Chr(10) +
        '请先安装 Google Chrome 或 Microsoft Edge，' + Chr(13) + Chr(10) +
        '否则 PUP Server 无法启动浏览器。' + Chr(13) + Chr(10) +
        Chr(13) + Chr(10) +
        '安装完成后无需重新安装本程序。',
        mbInformation,
        MB_OK
      );
    end
    else
    begin
      MsgBox(
        '检测到浏览器：' + ChromePath + Chr(13) + Chr(10) +
        Chr(13) + Chr(10) +
        '安装完成！请运行桌面快捷方式启动 PUP Server。',
        mbInformation,
        MB_OK
      );
    end;
  end;
end;
