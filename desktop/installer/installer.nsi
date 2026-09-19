; DeepSeek Harness Desktop — installer
;
; Built by scripts/build-installer.mjs, which passes:
;   /DPAYLOAD=<dir>                 the assembled portable application to embed
;   /DOUTFILE=<path>                where to write the setup executable
;   /DAPPVERSION=<ver>              product version shown in the UI and Add/Remove Programs
;   /DICONFILE=<path>               the product icon (.ico)
;   /DBUNDLED_NODE_VERSION=<ver>    the Node.js runtime shipped inside the payload
;   /DPAYLOAD_BYTES=<n>             uncompressed payload size, for the disk-space check
;   /DAPPFOLDER=<name>              folder created under a custom parent directory
;   /DALLOW_BUNDLED_NODE=0          refuse to continue unless a *system* Node.js exists
;
; Page flow
; ---------
;   1. 说明          what this installs, where data lives, what uninstall keeps
;   2. 运行环境检查   Node.js detection, with 重新检测 and a hard gate on 下一步
;   3. 安装范围       per-user or all-users (this is what may request elevation)
;   4. 安装位置        migrate an existing install, or pick where a fresh one goes
;   5. 组件 / 安装 / 完成
;
; Design notes
; ------------
; * ONE binary serves both install scopes. It starts deliberately *unelevated*
;   (`RequestExecutionLevel user`), shows a scope page, and re-launches itself
;   with `runas` only when the user picks the all-users option. Re-launching
;   instead of elevating up front matters: under an over-the-shoulder UAC prompt
;   `$LOCALAPPDATA` belongs to the *administrator's* profile, so a per-user
;   install performed by an already-elevated process would land in the wrong
;   user's directory. The elevated re-run skips pages 1-3, which are either
;   informational or already answered.
; * Node.js is detected but never *required* when the payload carries its own
;   runtime: the page reports both sources separately and only blocks when
;   neither exists. Blocking a machine that would work is worse than the thing
;   the check is protecting against. Set /DALLOW_BUNDLED_NODE=0 to gate on a
;   system Node.js alone.
; * All application data lives in `<install>\data` (see app/data-root.js). The
;   installer creates it, records why it exists, and — for an all-users install
;   into a protected location — grants the Users group modify rights, without
;   which the bundled dsh could not write sessions.
; * Migrating an existing install moves BOTH the program and its data, so what
;   the user sees is "the same app, in a new place". A cross-scope move is
;   refused with a reason instead of half-done, because removing the old
;   all-users shortcuts and registry entry needs the elevation this scope lacks.
; * Uninstalling keeps `data` unless the user explicitly asks for it to go.

Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "StrFunc.nsh"
!include "TextFunc.nsh"
!include "WinMessages.nsh"
!include "x64.nsh"
!include "nsDialogs.nsh"

; Flags are searched for as plain substrings: ${GetOptions} treats a valueless
; switch as an error, which is exactly what /machine and /DELETE_DATA are.
; StrFunc names the uninstaller declaration `Un<Name>` and the call `${un.<Name>}`.
; TextFunc has no ${Using:} mechanism — its macros are defined on include — so
; TrimNewLines is simply called as ${TrimNewLines}.
${Using:StrFunc} StrStr
${Using:StrFunc} UnStrStr

!ifndef PAYLOAD
  !error "PAYLOAD is not defined; build through scripts/build-installer.mjs"
!endif
!ifndef OUTFILE
  !error "OUTFILE is not defined; build through scripts/build-installer.mjs"
!endif
!ifndef APPNAME
  !define APPNAME "DeepSeek Harness"
!endif
!ifndef APPEXE
  !define APPEXE "DeepSeek Harness.exe"
!endif
!ifndef APPID
  !define APPID "DeepSeek Harness"
!endif
!ifndef APPPUBLISHER
  !define APPPUBLISHER "DeepSeek Harness Desktop"
!endif
!ifndef APPVERSION
  !define APPVERSION "0.0.0"
!endif
; Four numeric components, which is all VIProductVersion accepts.
!ifndef APPVI_VERSION
  !define APPVI_VERSION "0.0.0.0"
!endif
!ifndef ICONFILE
  !define ICONFILE ""
!endif
; The folder created under a parent the user picks. Also the folder name used when
; the parent itself is not already the product folder.
!ifndef APPFOLDER
  !define APPFOLDER "DSH Desktop"
!endif
!ifndef BUNDLED_NODE_VERSION
  !define BUNDLED_NODE_VERSION ""
!endif
!ifndef PAYLOAD_BYTES
  !define PAYLOAD_BYTES 0
!endif
; When 0, the bundled runtime does not satisfy the Node.js gate: only a Node.js
; found on this machine will. Off by default because the payload really does ship
; a runtime, and refusing to install over it would help nobody.
!ifndef ALLOW_BUNDLED_NODE
  !define ALLOW_BUNDLED_NODE 1
!endif
; Compile-time test seam. When 1, the detection below pretends this machine has
; no Node.js, which is the only way to verify that 下一步 really is blocked —
; the build machine has Node.js, so the blocked path cannot otherwise be reached.
; scripts/accept-install.mjs builds a throwaway copy with it and never touches
; the shipped build, where it stays 0.
!ifndef FORCE_NO_NODE
  !define FORCE_NO_NODE 0
!endif

!define REGKEY "Software\${APPID}"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPID}"
!define DATADIR "$INSTDIR\data"
; The location the official desktop build installs to: electron-builder's
; per-user default is %LOCALAPPDATA%\Programs\<product>.
!define OFFICIALDIR "$LOCALAPPDATA\Programs\${APPID}"
!define LOGFILE "$TEMP\${APPID}-install.log"
!define NOTFOUND "未检测到"

Name "${APPNAME}"
OutFile "${OUTFILE}"
InstallDir "${OFFICIALDIR}"
ShowInstDetails show
ShowUninstDetails show
BrandingText "${APPNAME} ${APPVERSION}"
RequestExecutionLevel user

; ── compression ─────────────────────────────────────────────────────────────
; Measured on this tree (688.4 MB / 25,972 files), silent install against a
; 4.8 s multi-threaded copy of the same tree:
;
;   LZMA  (dict 64)   156.7 MB setup   25.0 s install
;   stored            ~675 MB setup    12.1 s install
;
; So the 20.2 s above the I/O floor splits roughly in half: ~12.9 s of
; single-threaded LZMA decompression and ~7.3 s of NSIS writing 25,972 files one
; at a time. Neither alone explains it, which is why the compressor is now a
; build parameter rather than a hard-coded choice.
;
;   /DCOMPRESSOR=lzma|zlib|bzip2   default lzma (smallest download)
;   /DDICTSIZE=<MB>                LZMA dictionary, default 64
;   /DNO_COMPRESS=1                store uncompressed; far too large to ship, but
;                                  it is the experiment that isolates
;                                  decompression cost from per-file write cost.
!ifndef NO_COMPRESS
  !define NO_COMPRESS 0
!endif
!ifndef DICTSIZE
  !define DICTSIZE 64
!endif
!ifndef COMPRESSOR
  !define COMPRESSOR lzma
!endif

!if ${NO_COMPRESS} = 1
  SetCompress off
!else
  SetCompressor /SOLID ${COMPRESSOR}
  ; zlib has a fixed 32 KB window; SetCompressorDictSize is LZMA/bzip2-only.
  !if "${COMPRESSOR}" != "zlib"
    SetCompressorDictSize ${DICTSIZE}
  !endif
!endif

VIProductVersion "${APPVI_VERSION}"
VIAddVersionKey "ProductName" "${APPNAME}"
VIAddVersionKey "FileDescription" "${APPNAME} 安装程序"
VIAddVersionKey "FileVersion" "${APPVERSION}"
VIAddVersionKey "ProductVersion" "${APPVERSION}"
VIAddVersionKey "CompanyName" "${APPPUBLISHER}"
VIAddVersionKey "LegalCopyright" "MIT"

!if "${ICONFILE}" != ""
  !define MUI_ICON "${ICONFILE}"
  !define MUI_UNICON "${ICONFILE}"
!endif
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "立即启动 ${APPNAME}"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchApp
!define MUI_FINISHPAGE_LINK "查看使用说明"
!define MUI_FINISHPAGE_LINK_LOCATION "$INSTDIR\使用说明.txt"

; 1. 安装包说明
!define MUI_WELCOMEPAGE_TITLE "欢迎安装 ${APPNAME} 桌面版"
!define MUI_WELCOMEPAGE_TEXT "本安装程序会把「${APPNAME} 桌面版」安装到你的电脑。$\r$\n$\r$\n它自带完整的 dsh 与 Node.js 运行时，装好之后双击图标就能用，不需要另行配置环境。$\r$\n$\r$\n安装过程中会依次：$\r$\n    · 检查 Node.js 运行环境（缺失时不会让你继续）$\r$\n    · 检测是否已经装过桌面版或命令行 dsh$\r$\n    · 已装过：可以把它连同数据迁移到新目录；没装过：选择安装位置$\r$\n$\r$\n你的会话、设置与凭据都保存在安装目录下的 data 文件夹里，整个目录可以直接复制备份。卸载时默认会保留 data，不会丢数据。$\r$\n$\r$\n点「下一步」继续。"

Var IsMachine          ; "1" when installing for all users
Var IsRelaunch         ; "1" when this process is the elevated re-launch
Var DefaultUserDir     ; the per-user default, captured before the shell var context moves
Var ScopeDialog
Var RadioUser
Var RadioMachine

Var NodeDialog
Var NodeSystemValue
Var NodeBundledValue
Var NodeVerdict
Var NodeRefreshBtn
Var NodeLinkBtn
Var SystemNodePath
Var SystemNodeVersion
Var NodeReady          ; "1" when a usable Node.js runtime is available

Var TargetDialog
Var TargetField
Var TargetBrowseBtn
Var TargetDetail
Var RadioMigrate
Var RadioKeep
Var DesktopFound       ; "1" when a desktop install was detected
Var DesktopDir
Var DesktopScope       ; "user" | "machine"
Var CliFound           ; "1" when a command-line dsh was detected
Var CliDetail
Var MigrateChosen      ; "1" when the user asked to move an existing install
Var ParentChosen       ; a folder the user picked (browse button or /PARENT=)
Var OldDir
Var InstallError

; ── pages ───────────────────────────────────────────────────────────────────
!define MUI_PAGE_CUSTOMFUNCTION_PRE WelcomePre
!insertmacro MUI_PAGE_WELCOME
; The runtime check comes BEFORE the scope page on purpose. Choosing all-users
; relaunches this installer elevated and quits the current process, so anything
; after the scope page would never be seen in that run. Checking first also means
; the gate is answered once, unelevated, before any UAC prompt appears.
Page custom NodePageCreate NodePageLeave
Page custom ScopePageCreate ScopePageLeave
Page custom TargetPageCreate TargetPageLeave
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

; ── logging ─────────────────────────────────────────────────────────────────
; A hand-rolled log rather than NSIS's LogSet: the path is predictable, it works
; before $INSTDIR exists, and it is what the failure dialog points the user at.
;
; The encoding is UTF-16LE with a BOM, written with FileWriteUTF16LE. Plain
; FileWrite is NOT usable here: in a Unicode build it converts to the system
; ANSI codepage, which silently turns every non-ASCII character into "?" on a
; machine whose locale is not Chinese — destroying the failure reason exactly
; when the user needs it. FileWriteUTF16LE is lossless on every locale.
Function LogLine
  FileOpen $9 "${LOGFILE}" a
  ${If} $9 != ""
    FileSeek $9 0 END
    FileWriteUTF16LE $9 "$0$\r$\n"
    FileClose $9
  ${EndIf}
FunctionEnd

Function LogReset
  Delete "${LOGFILE}"
  FileOpen $9 "${LOGFILE}" w
  ${If} $9 != ""
    ; U+FEFF as a little-endian byte order mark, so Notepad and editors detect
    ; the encoding instead of guessing the local ANSI codepage.
    FileWriteByte $9 255
    FileWriteByte $9 254
    FileClose $9
  ${EndIf}
  StrCpy $0 "=== ${APPNAME} ${APPVERSION} 安装日志 ==="
  Call LogLine
FunctionEnd

; ── environment detection ───────────────────────────────────────────────────
; Look for a Node.js the *user* installed: PATH first, then the registry, then
; the usual per-user and per-machine locations (including the popular version
; managers, which do not put node.exe on PATH until a version is activated).
Function DetectSystemNode
  StrCpy $SystemNodePath ""
  StrCpy $SystemNodeVersion ""

  ${If} ${FORCE_NO_NODE} == 1
    StrCpy $0 "FORCE_NO_NODE=1：跳过检测（仅用于验收测试）"
    Call LogLine
    Return
  ${EndIf}

  ClearErrors
  SearchPath $0 "node.exe"
  ${IfNot} ${Errors}
  ${AndIf} $0 != ""
    StrCpy $SystemNodePath "$0"
  ${EndIf}

  ${If} $SystemNodePath == ""
    ReadRegStr $0 HKLM "SOFTWARE\nodejs" "InstallPath"
    ${If} $0 != ""
    ${AndIf} ${FileExists} "$0\node.exe"
      StrCpy $SystemNodePath "$0\node.exe"
    ${EndIf}
  ${EndIf}

  ${If} $SystemNodePath == ""
    ${If} ${FileExists} "$PROGRAMFILES64\nodejs\node.exe"
      StrCpy $SystemNodePath "$PROGRAMFILES64\nodejs\node.exe"
    ${ElseIf} ${FileExists} "$PROGRAMFILES\nodejs\node.exe"
      StrCpy $SystemNodePath "$PROGRAMFILES\nodejs\node.exe"
    ${ElseIf} ${FileExists} "$LOCALAPPDATA\Programs\nodejs\node.exe"
      StrCpy $SystemNodePath "$LOCALAPPDATA\Programs\nodejs\node.exe"
    ${ElseIf} ${FileExists} "$APPDATA\nvm\node.exe"
      StrCpy $SystemNodePath "$APPDATA\nvm\node.exe"
    ${ElseIf} ${FileExists} "$LOCALAPPDATA\Volta\bin\node.exe"
      StrCpy $SystemNodePath "$LOCALAPPDATA\Volta\bin\node.exe"
    ${ElseIf} ${FileExists} "$LOCALAPPDATA\fnm_multishells\*\node.exe"
      StrCpy $SystemNodePath "$LOCALAPPDATA\fnm_multishells\*\node.exe"
    ${EndIf}
  ${EndIf}

  ${If} $SystemNodePath != ""
    nsExec::ExecToStack '"$SystemNodePath" -v'
    Pop $0
    Pop $1
    ${TrimNewLines} "$1" $1
    ${If} $0 == "0"
    ${AndIf} $1 != ""
      StrCpy $SystemNodeVersion "$1"
    ${Else}
      ; The file exists but would not run — report it as detected but unusable
      ; rather than pretending there is no Node.js at all.
      StrCpy $SystemNodeVersion "（无法执行）"
    ${EndIf}
  ${EndIf}
FunctionEnd

; A desktop install is found through the registry it wrote, then by looking in
; the two default locations the official build uses.
Function DetectDesktop
  StrCpy $DesktopFound "0"
  StrCpy $DesktopDir ""
  StrCpy $DesktopScope ""

  ReadRegStr $0 HKCU "${REGKEY}" "InstallDir"
  ${If} $0 != ""
    StrCpy $DesktopDir "$0"
    StrCpy $DesktopScope "user"
  ${Else}
    ReadRegStr $0 HKLM "${REGKEY}" "InstallDir"
    ${If} $0 != ""
      StrCpy $DesktopDir "$0"
      StrCpy $DesktopScope "machine"
    ${EndIf}
  ${EndIf}

  ; A registry entry can outlive a hand-deleted directory; treat that as "not
  ; installed" and say so in the log instead of trying to migrate nothing.
  ${If} $DesktopDir != ""
  ${AndIfNot} ${FileExists} "$DesktopDir\${APPEXE}"
    StrCpy $0 "注册表记录 $DesktopDir，但那里没有 ${APPEXE}（视为未安装）"
    Call LogLine
    StrCpy $DesktopDir ""
  ${EndIf}

  ${If} $DesktopDir == ""
    ${If} ${FileExists} "${OFFICIALDIR}\${APPEXE}"
      StrCpy $DesktopDir "${OFFICIALDIR}"
      StrCpy $DesktopScope "user"
    ${ElseIf} ${FileExists} "$PROGRAMFILES64\${APPID}\${APPEXE}"
      StrCpy $DesktopDir "$PROGRAMFILES64\${APPID}"
      StrCpy $DesktopScope "machine"
    ${EndIf}
  ${EndIf}

  ${If} $DesktopDir != ""
    StrCpy $DesktopFound "1"
  ${EndIf}
FunctionEnd

; Command-line dsh: a shim on PATH, shims the package managers create, a global
; npm/pnpm install, or simply an existing data directory. Any one of them means
; the user already uses dsh, which is worth telling them before we touch anything.
Function DetectCliDsh
  StrCpy $CliFound "0"
  StrCpy $CliDetail ""

  SearchPath $0 "dsh.cmd"
  ${If} $0 == ""
    SearchPath $0 "dsh.exe"
  ${EndIf}
  ${If} $0 == ""
    SearchPath $0 "dsh"
  ${EndIf}
  ${If} $0 != ""
    StrCpy $CliFound "1"
    StrCpy $CliDetail "PATH 上的 dsh（$0）"
  ${EndIf}

  ${If} $CliFound == "0"
  ${AndIf} ${FileExists} "$APPDATA\npm\dsh.cmd"
    StrCpy $CliFound "1"
    StrCpy $CliDetail "npm 全局目录（$APPDATA\npm\dsh.cmd）"
  ${EndIf}

  ${If} $CliFound == "0"
  ${AndIf} ${FileExists} "$LOCALAPPDATA\pnpm\dsh.cmd"
    StrCpy $CliFound "1"
    StrCpy $CliDetail "pnpm 全局目录（$LOCALAPPDATA\pnpm\dsh.cmd）"
  ${EndIf}

  ; A global package install, asked of npm itself when a system Node.js exists.
  ${If} $CliFound == "0"
  ${AndIf} $SystemNodePath != ""
    nsExec::ExecToStack '"$SYSDIR\cmd.exe" /c npm root -g'
    Pop $0
    Pop $1
    ${TrimNewLines} "$1" $1
    ${If} $0 == "0"
    ${AndIf} $1 != ""
    ${AndIf} ${FileExists} "$1\@deepseek-ai\dsh"
      StrCpy $CliFound "1"
      StrCpy $CliDetail "全局 npm 包（$1\@deepseek-ai\dsh）"
    ${EndIf}
  ${EndIf}

  ${If} $CliFound == "0"
    ReadRegStr $0 HKCU "Environment" "DSH_HOME"
    ${If} $0 == ""
      ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "DSH_HOME"
    ${EndIf}
    ${If} $0 != ""
    ${AndIf} ${FileExists} "$0\*.*"
      StrCpy $CliFound "1"
      StrCpy $CliDetail "已有的数据目录（$0）"
    ${ElseIf} ${FileExists} "$PROFILE\.dsh\*.*"
      StrCpy $CliFound "1"
      StrCpy $CliDetail "已有的数据目录（$PROFILE\.dsh）"
    ${EndIf}
  ${EndIf}
FunctionEnd

; ── startup ─────────────────────────────────────────────────────────────────
Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "本程序只支持 64 位 Windows。"
    Abort
  ${EndIf}

  StrCpy $IsMachine "0"
  StrCpy $IsRelaunch "0"
  StrCpy $MigrateChosen "0"
  StrCpy $ParentChosen ""
  StrCpy $InstallError ""
  ; Capture the per-user default while the context is still `current`: the
  ; constants below are context-sensitive, and this is also the value NSIS
  ; already put in $INSTDIR — which is how a `/D=` override is recognised.
  StrCpy $DefaultUserDir "${OFFICIALDIR}"

  Call LogReset

  ; The parameter string is kept in $R3, not $R0: InstallDirFromParent below
  ; works in $R0-$R2, and it is called before /DIR= is read.
  ${GetParameters} $R3
  ${StrStr} $R1 "$R3" "/machine"
  ${If} $R1 != ""
    StrCpy $IsMachine "1"
    StrCpy $IsRelaunch "1"
  ${EndIf}

  ; /PARENT= is a folder the *user* chose, so it goes through the same
  ; "append ${APPFOLDER}" rule as the browse button. Applied here rather than on
  ; the page so that a silent install honours it too — silent runs show no pages,
  ; so page-only logic would be skipped entirely.
  ${GetOptions} $R3 "/PARENT=" $R2
  ${IfNot} ${Errors}
  ${AndIf} $R2 != ""
    StrCpy $ParentChosen "$R2"
    StrCpy $R0 "$R2"
    Call InstallDirFromParent
  ${EndIf}

  ; /DIR= is the final directory verbatim, so it is read last and wins over
  ; /PARENT=. It also lets the elevated re-run (and scripted installs) start from
  ; a known location without asking the user again.
  ${GetOptions} $R3 "/DIR=" $R2
  ${IfNot} ${Errors}
  ${AndIf} $R2 != ""
    StrCpy $INSTDIR "$R2"
  ${EndIf}

  ; `/D=` is applied by NSIS *before* this function runs, so it is respected by
  ; simply not overwriting $INSTDIR unless it still holds the declared default.
  ${If} $INSTDIR == "${OFFICIALDIR}"
    ${If} $IsMachine == "1"
      SetShellVarContext all
      StrCpy $INSTDIR "$PROGRAMFILES64\${APPID}"
      ReadRegStr $0 HKLM "${REGKEY}" "InstallDir"
      ${If} $0 != ""
        StrCpy $INSTDIR $0
      ${EndIf}
    ${Else}
      SetShellVarContext current
      ReadRegStr $0 HKCU "${REGKEY}" "InstallDir"
      ${If} $0 != ""
        StrCpy $INSTDIR $0
      ${EndIf}
    ${EndIf}
  ${Else}
    ; An explicit /D= was passed, so honour the scope only.
    ${If} $IsMachine == "1"
      SetShellVarContext all
    ${Else}
      SetShellVarContext current
    ${EndIf}
  ${EndIf}

  Call DetectSystemNode
  Call DetectDesktop
  Call DetectCliDsh

  StrCpy $0 "系统 Node.js: ${NOTFOUND}"
  ${If} $SystemNodePath != ""
    StrCpy $0 "系统 Node.js: $SystemNodePath ($SystemNodeVersion)"
  ${EndIf}
  Call LogLine
  StrCpy $0 "桌面版: $DesktopFound $DesktopDir"
  Call LogLine
  StrCpy $0 "命令行 dsh: $CliFound $CliDetail"
  Call LogLine
FunctionEnd

; The elevated re-launch already showed the welcome page in the unelevated run.
Function WelcomePre
  ${If} $IsRelaunch == "1"
    Abort
  ${EndIf}
FunctionEnd

; ── 3. install scope ────────────────────────────────────────────────────────
Function ScopePageCreate
  ; The elevated re-launch has already been told the scope: it was chosen by the
  ; unelevated process that started it.
  ${If} $IsRelaunch == "1"
    Abort
  ${EndIf}

  !insertmacro MUI_HEADER_TEXT "选择安装范围" "为当前用户安装不需要管理员权限。"

  nsDialogs::Create 1018
  Pop $ScopeDialog
  ${If} $ScopeDialog == error
    Abort
  ${EndIf}

  ${NSD_CreateRadioButton} 0 0u 100% 12u "仅为我安装（推荐）"
  Pop $RadioUser
  ${NSD_CreateLabel} 14u 13u 100% 22u "安装到 ${OFFICIALDIR}。会话、设置与凭据等数据也都保存在这个目录里，整个目录可以直接复制或删除。不需要管理员权限。"
  Pop $0

  ${NSD_CreateRadioButton} 0 44u 100% 12u "为所有用户安装"
  Pop $RadioMachine
  ${NSD_CreateLabel} 14u 57u 100% 22u "安装到 $PROGRAMFILES64\${APPID}。会请求一次管理员权限（UAC）。本机所有用户共用同一份数据。"
  Pop $0

  ${NSD_Check} $RadioUser
  nsDialogs::Show
FunctionEnd

Function ScopePageLeave
  ${NSD_GetState} $RadioMachine $0
  ${If} $0 == ${BST_CHECKED}
    ; Hand off to an elevated copy and leave this one. See the header comment.
    ClearErrors
    ExecShell "runas" "$EXEPATH" "/machine"
    ${If} ${Errors}
      MessageBox MB_ICONSTOP "无法请求管理员权限，安装已取消。若要继续，请以管理员身份运行本安装程序。"
      Abort
    ${EndIf}
    Quit
  ${EndIf}
FunctionEnd

; ── 2. Node.js runtime check ────────────────────────────────────────────────
; Decide whether a usable runtime exists, and enable/disable 「下一步」 to match.
; Called on page entry and again after 重新检测.
Function UpdateNodeGate
  Call DetectSystemNode

  ${If} $SystemNodePath != ""
    StrCpy $1 "已检测到 Node.js $SystemNodeVersion"
    StrCpy $2 "$SystemNodePath"
  ${Else}
    StrCpy $1 "未检测到"
    StrCpy $2 "没有在 PATH、注册表或常见安装位置找到 node.exe"
  ${EndIf}
  ${NSD_SetText} $NodeSystemValue "$1"
  ; An empty /DBUNDLED_NODE_VERSION means this build ships no runtime, and the
  ; line must say so rather than claiming one is included.
  ${If} "${BUNDLED_NODE_VERSION}" == ""
    ${NSD_SetText} $NodeBundledValue "无（本次构建未内置运行时）"
  ${Else}
    ${NSD_SetText} $NodeBundledValue "${BUNDLED_NODE_VERSION}（随安装包提供，无需单独安装）"
  ${EndIf}

  ; The gate. A bundled runtime only counts when the build allows it, so that
  ; /DALLOW_BUNDLED_NODE=0 gives the stricter "system Node.js only" behaviour.
  StrCpy $NodeReady "0"
  ${If} $SystemNodePath != ""
    StrCpy $NodeReady "1"
    StrCpy $3 "✓ 已检测到 Node.js（系统安装）$\r$\n$2"
  ${ElseIf} "${BUNDLED_NODE_VERSION}" != ""
  ${AndIf} ${ALLOW_BUNDLED_NODE} == 1
    StrCpy $NodeReady "1"
    StrCpy $3 "✓ 已检测到 Node.js（安装包内置 ${BUNDLED_NODE_VERSION}）$\r$\n本安装包自带运行时，不需要你先装 Node.js。若想使用自己安装的 Node.js，装好后点「重新检测」即可。"
  ${Else}
    StrCpy $3 "✗ 需要先安装 Node.js$\r$\n本程序需要 Node.js 运行环境。请到 nodejs.org 安装（建议 24.x 或更高），装完后回到这里点「重新检测」。"
  ${EndIf}
  ${NSD_SetText} $NodeVerdict "$3"

  GetDlgItem $0 $HWNDPARENT 1
  ${If} $NodeReady == "1"
    EnableWindow $0 1
  ${Else}
    EnableWindow $0 0
  ${EndIf}

  StrCpy $0 "Node 检测: 系统=$SystemNodeVersion 内置=${BUNDLED_NODE_VERSION} 可用=$NodeReady"
  Call LogLine
FunctionEnd

Function NodeRefreshClick
  Call UpdateNodeGate
FunctionEnd

Function NodeLinkClick
  ExecShell "open" "https://nodejs.org/zh-cn/download"
FunctionEnd

Function NodePageCreate
  ; The elevated re-launch already passed this gate in the unelevated run.
  ${If} $IsRelaunch == "1"
    Abort
  ${EndIf}

  !insertmacro MUI_HEADER_TEXT "运行环境检查" "安装前先确认 Node.js 运行环境。"

  nsDialogs::Create 1018
  Pop $NodeDialog
  ${If} $NodeDialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0u 46u 12u "系统 Node.js："
  Pop $0
  ${NSD_CreateLabel} 46u 0u 100% 12u ""
  Pop $NodeSystemValue

  ${NSD_CreateLabel} 0 14u 46u 12u "安装包内置："
  Pop $0
  ${NSD_CreateLabel} 46u 14u 100% 12u ""
  Pop $NodeBundledValue

  ${NSD_CreateLabel} 0 34u 100% 34u ""
  Pop $NodeVerdict

  ${NSD_CreateButton} 0 74u 56u 15u "重新检测"
  Pop $NodeRefreshBtn
  ${NSD_OnClick} $NodeRefreshBtn NodeRefreshClick

  ${NSD_CreateButton} 62u 74u 96u 15u "打开 nodejs.org 下载页"
  Pop $NodeLinkBtn
  ${NSD_OnClick} $NodeLinkBtn NodeLinkClick

  Call UpdateNodeGate
  nsDialogs::Show
FunctionEnd

Function NodePageLeave
  ; Authoritative gate: the button state is set for the user's benefit, but this
  ; is what actually stops the install when no runtime is available.
  ${If} $NodeReady != "1"
    MessageBox MB_ICONEXCLAMATION "还没有检测到 Node.js。$\r$\n$\r$\n请先安装 Node.js，然后点「重新检测」。"
    Abort
  ${EndIf}
FunctionEnd

; ── 4. install location ─────────────────────────────────────────────────────
; The final directory for a parent the user picked: `<parent>\${APPFOLDER}`, unless
; the parent is already the product folder (so picking it twice does not nest).
;
; Input in $R0, output in $INSTDIR. Values are held in registers because the
; FileFunc macros work in $0-$9 — and note the argument order: FileFunc takes
; (input, result) while the StrFunc family takes (result, input...). Getting that
; backwards is what made this function write the basename *into* its own input,
; producing paths like "已检测到 Node.js v24.21.0\DSH Desktop".
Function InstallDirFromParent
  ; A folder picker can return a trailing backslash ("D:\tools\", or just "C:\").
  ; Drop it unconditionally: the separator is added back below, so a drive root
  ; ends up as "C:\DSH Desktop" rather than "C:\\DSH Desktop".
  StrCpy $R1 "$R0" 1 -1
  ${If} $R1 == "\"
    StrCpy $R0 "$R0" -1
  ${EndIf}

  ${GetFileName} "$R0" $R1
  ${If} $R1 == "${APPFOLDER}"
    StrCpy $INSTDIR "$R0"
  ${ElseIf} $R1 == "${APPID}"
    StrCpy $INSTDIR "$R0"
  ${Else}
    StrCpy $INSTDIR "$R0\${APPFOLDER}"
  ${EndIf}
FunctionEnd

Function TargetBrowseClick
  nsDialogs::SelectFolderDialog "选择安装位置（会在其中创建 ${APPFOLDER} 文件夹）" "$LOCALAPPDATA\Programs"
  Pop $0
  ${If} $0 != error
    ${If} $0 != ""
      StrCpy $ParentChosen "$0"
      StrCpy $R0 "$0"
      Call InstallDirFromParent
      ${NSD_SetText} $TargetField "$INSTDIR"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function TargetMigrateClick
  ; Picking 「迁移」 means the install goes somewhere the user still has to
  ; choose, so the browse button becomes the next thing to do.
  ${NSD_SetText} $TargetDetail "已选择迁移。请用「更改安装位置…」指定新位置，现有程序与 data 数据都会搬过去。"
FunctionEnd

Function TargetKeepClick
  ${NSD_SetText} $TargetDetail "保持原目录：就地更新程序文件，数据留在原处。"
FunctionEnd

Function TargetPageCreate
  !insertmacro MUI_HEADER_TEXT "选择安装位置" "已检测到旧版本时可以把它连同数据一起迁移。"

  nsDialogs::Create 1018
  Pop $TargetDialog
  ${If} $TargetDialog == error
    Abort
  ${EndIf}

  ; /PARENT= has already been applied in .onInit (so that silent installs honour
  ; it), and the field below simply displays the resulting $INSTDIR.

  ; Layout is built as a vertical stack whose height depends on how much has to
  ; be reported, so the "安装到" block below always lands in free space.
  ${If} $DesktopFound == "1"
    ${NSD_CreateLabel} 0 0u 100% 11u "已检测到已安装的桌面版（$DesktopScope 安装）："
    Pop $0
    ${NSD_CreateLabel} 0 12u 100% 11u "$DesktopDir"
    Pop $0
    ${If} $CliFound == "1"
      ${NSD_CreateLabel} 0 24u 100% 20u "命令行 dsh：$CliDetail$\r$\n命令行 dsh 的数据不在安装目录里，迁移不会动它。"
      Pop $0
    ${Else}
      ${NSD_CreateLabel} 0 24u 100% 11u "命令行 dsh：${NOTFOUND}"
      Pop $0
    ${EndIf}

    ${NSD_CreateRadioButton} 0 45u 100% 11u "迁移到新的安装目录（程序与数据一起搬过去）"
    Pop $RadioMigrate
    ${NSD_OnClick} $RadioMigrate TargetMigrateClick
    ${NSD_CreateRadioButton} 0 57u 100% 11u "保持当前目录，就地更新"
    Pop $RadioKeep
    ${NSD_OnClick} $RadioKeep TargetKeepClick
    ${NSD_Check} $RadioKeep

    ${NSD_CreateLabel} 0 67u 100% 20u "数据留在原处，程序文件更新为新版本。"
    Pop $TargetDetail
    StrCpy $7 "88"
  ${Else}
    ${NSD_CreateLabel} 0 0u 100% 11u "未检测到已安装的桌面版，将为你新装一份。"
    Pop $0
    ${If} $CliFound == "1"
      ${NSD_CreateLabel} 0 12u 100% 20u "命令行 dsh：$CliDetail$\r$\n桌面版会与它共用同一份 dsh 数据（下方「让命令行 dsh 共用本目录的数据」）。"
      Pop $0
    ${Else}
      ${NSD_CreateLabel} 0 12u 100% 11u "命令行 dsh：${NOTFOUND}"
      Pop $0
    ${EndIf}
    ${NSD_CreateLabel} 0 34u 100% 20u "下框是最终安装目录。默认与官网的自动安装一致；点「更改安装位置…」选择别的位置时，会在其中创建 ${APPFOLDER} 文件夹。"
    Pop $0
    StrCpy $7 "58"
  ${EndIf}

  ; Vertical stacking is computed in dialog units. The arithmetic runs on the
  ; numeric part and `u` is re-appended, because nsDialogs reads a bare number as
  ; *pixels* — mixing the two silently overlapped this label with its own text
  ; box. Everything here must stay suffixed, and inside the 300x140-unit page.
  ${NSD_CreateLabel} 0 "$7u" 100% 11u "安装到："
  Pop $0
  System::Int64Op $7 + 13
  Pop $8
  ${NSD_CreateText} 0 "$8u" 100% 13u "$INSTDIR"
  Pop $TargetField
  SendMessage $TargetField ${EM_SETREADONLY} 1 0
  System::Int64Op $8 + 17
  Pop $8
  ${NSD_CreateButton} 0 "$8u" 45% 15u "更改安装位置…"
  Pop $TargetBrowseBtn
  ${NSD_OnClick} $TargetBrowseBtn TargetBrowseClick

  nsDialogs::Show
FunctionEnd

; Refuse to continue for a reason the user can act on, rather than failing
; halfway through copying a 600 MB payload.
Function TargetPageLeave
  ${If} $DesktopFound == "1"
    ${NSD_GetState} $RadioMigrate $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $MigrateChosen "1"
      StrCpy $OldDir "$DesktopDir"
    ${Else}
      StrCpy $MigrateChosen "0"
      ; 就地更新：the location is the existing one, so the field is advisory.
      StrCpy $INSTDIR "$DesktopDir"
    ${EndIf}
  ${Else}
    StrCpy $MigrateChosen "0"
  ${EndIf}

  ${If} $INSTDIR == ""
    MessageBox MB_ICONEXCLAMATION "请先选择安装位置。"
    Abort
  ${EndIf}

  ; An existing all-users install sits in Program Files, so BOTH migrating it and
  ; updating it in place need elevation: this unelevated process would fail to
  ; write there. Checking now means the user learns why before a 600 MB copy.
  ${If} $DesktopFound == "1"
  ${AndIf} $DesktopScope == "machine"
  ${AndIf} $IsMachine != "1"
    MessageBox MB_ICONEXCLAMATION "旧版本是「为所有用户安装」的，位于 $DesktopDir。$\r$\n$\r$\n更新或迁移它都需要管理员权限。请以管理员身份重新运行本安装程序，或先卸载旧版本再安装。"
    Abort
  ${EndIf}

  ; A relative path (e.g. typed by hand into a scripted /DIR=) is not something
  ; this installer can resolve meaningfully, and `..` segments would make the
  ; "is the target inside the old install" test below unreliable.
  ${StrStr} $0 "$INSTDIR" ".."
  ${If} $0 != ""
    MessageBox MB_ICONEXCLAMATION "安装位置不能包含「..」，请选择一个完整路径。$\r$\n$\r$\n当前：$INSTDIR"
    Abort
  ${EndIf}

  ${If} $MigrateChosen == "1"
    ${If} $INSTDIR == "$OldDir"
      ; Same place means there is nothing to move.
      StrCpy $MigrateChosen "0"
    ${EndIf}
    ${If} $MigrateChosen == "1"
      ${StrStr} $0 "$INSTDIR" "$OldDir\"
      ${If} $0 != ""
        MessageBox MB_ICONEXCLAMATION "新的安装目录不能位于旧目录里面。$\r$\n$\r$\n旧：$OldDir$\r$\n新：$INSTDIR"
        Abort
      ${EndIf}
      ${StrStr} $0 "$OldDir" "$INSTDIR\"
      ${If} $0 != ""
        MessageBox MB_ICONEXCLAMATION "旧目录不能位于新的安装目录里面。$\r$\n$\r$\n旧：$OldDir$\r$\n新：$INSTDIR"
        Abort
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ; Is the destination writable? Create and remove a probe file, which also
  ; creates the directory the copy needs.
  CreateDirectory "$INSTDIR"
  ClearErrors
  FileOpen $0 "$INSTDIR\.dsh-write-test" w
  ${If} ${Errors}
    MessageBox MB_ICONEXCLAMATION "没有写入权限，无法安装到：$\r$\n$INSTDIR$\r$\n$\r$\n请换一个位置，或以管理员身份运行。"
    Abort
  ${EndIf}
  FileClose $0
  Delete "$INSTDIR\.dsh-write-test"

  ; Disk space: advisory, because the estimate is only as good as the payload
  ; metadata and blocking a workable install would be worse than the risk.
  ; GetDiskFreeSpaceExW is called directly so the unit (bytes → MB) is explicit
  ; rather than depending on a helper macro's convention.
  ${If} ${PAYLOAD_BYTES} > 0
    ${GetRoot} "$INSTDIR" $0
    System::Call 'kernel32::GetDiskFreeSpaceExW(w "$0", *l .r1, *l .r2, *l .r3) i .r4'
    ${If} $4 != 0
      System::Int64Op $1 / 1048576
      Pop $1
      System::Int64Op $9 ${PAYLOAD_BYTES} / 1048576
      Pop $9
      System::Int64Op $9 * 13
      Pop $9
      System::Int64Op $9 / 10
      Pop $9
      System::Int64Op $9 + 100
      Pop $9
      StrCpy $0 "磁盘: $0 可用 $1 MB, 预计需要 $9 MB"
      Call LogLine
      ${If} $1 < $9
        MessageBox MB_YESNO|MB_ICONEXCLAMATION "目标磁盘剩余空间可能不足：$\r$\n$\r$\n可用约 $1 MB，预计需要约 $9 MB。$\r$\n$\r$\n仍然继续吗？" IDYES +2
        Abort
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ; A running copy holds electron-core.exe open, so the copy would fail with a
  ; bare "error" much later. Say it now, while it is still actionable.
  ${If} $DesktopFound == "1"
  ${AndIf} ${FileExists} "$DesktopDir\electron-core.exe"
    ClearErrors
    FileOpen $0 "$DesktopDir\electron-core.exe" a
    ${If} ${Errors}
      MessageBox MB_ICONEXCLAMATION "${APPNAME} 正在运行，无法更新它的文件。$\r$\n$\r$\n请先退出正在运行的 ${APPNAME}，然后点「上一步」再回来，或重新运行安装程序。"
      Abort
    ${EndIf}
    FileClose $0
  ${EndIf}

  StrCpy $0 "目标目录: $INSTDIR 迁移=$MigrateChosen 旧=$OldDir"
  Call LogLine
FunctionEnd

; ── failure reporting ───────────────────────────────────────────────────────
; One place that turns a raw NSIS failure into a reason, a log entry and — for an
; interactive install — a dialog naming the log file. $0 is the reason; this does
; not return.
Function InstallFail
  StrCpy $InstallError "$0"
  ; LogLine writes $0, so the prefixed line has to be put back into $0 — an
  ; earlier version built the message in $1 and the log therefore recorded the
  ; bare reason with no "安装失败" marker.
  StrCpy $0 "安装失败：$InstallError"
  Call LogLine
  DetailPrint "✗ $InstallError"

  ; The dialog is shown ONLY in an interactive install. NSIS displays MessageBox
  ; even under /S, and a modal box that nobody can click blocks an unattended
  ; install forever — measured, not assumed. Silent installs therefore get the
  ; reason from the log and the non-zero exit code instead.
  ${IfNot} ${Silent}
    MessageBox MB_ICONSTOP "安装失败。$\r$\n$\r$\n原因：$InstallError$\r$\n$\r$\n日志：${LOGFILE}"
  ${EndIf}

  ; An explicit non-zero exit code, so an unattended run can tell success from
  ; failure without inspecting the tree.
  SetErrorLevel 1
  SetErrors
  Abort
FunctionEnd

; ── sections ────────────────────────────────────────────────────────────────
Section "程序文件" SecCore
  SectionIn RO

  StrCpy $0 "开始安装到 $INSTDIR"
  Call LogLine

  CreateDirectory "$INSTDIR"
  ${IfNot} ${FileExists} "$INSTDIR\*.*"
    StrCpy $0 "无法创建安装目录（可能是权限不足或路径无效）"
    Call InstallFail
  ${EndIf}

  SetOutPath "$INSTDIR"
  SetOverwrite on
  ClearErrors
  File /r "${PAYLOAD}\*.*"
  ${If} ${Errors}
    StrCpy $0 "复制程序文件失败（可能是磁盘空间不足、权限不足，或目标目录正被占用）"
    Call InstallFail
  ${EndIf}
  ${IfNot} ${FileExists} "$INSTDIR\${APPEXE}"
    StrCpy $0 "程序文件复制不完整：缺少 ${APPEXE}"
    Call InstallFail
  ${EndIf}
  StrCpy $0 "程序文件复制完成"
  Call LogLine

  ; ── migrate an existing install ───────────────────────────────────────────
  ; Done BEFORE the data directories are created, because moving a directory
  ; onto an existing one fails (and `robocopy /MOVE` would then merge into it,
  ; which could overwrite newer sessions with older ones).
  ${If} $MigrateChosen == "1"
    ${If} ${FileExists} "${DATADIR}\*.*"
      StrCpy $0 "新安装目录里已经存在 data，为避免覆盖其中的会话与设置，迁移已停止。请换一个空目录，或先手动处理 $INSTDIR\data"
      Call InstallFail
    ${EndIf}

    DetailPrint "正在迁移数据：$OldDir\data → ${DATADIR}"
    StrCpy $0 "迁移: $OldDir → $INSTDIR"
    Call LogLine

    ${If} ${FileExists} "$OldDir\data\*.*"
      ; Same volume: a rename is instant and atomic, which is all a multi-GB
      ; data directory should ever need.
      ClearErrors
      Rename "$OldDir\data" "${DATADIR}"
      ${If} ${Errors}
        ; Different volume. robocopy is the only recursive mover Windows ships.
        DetailPrint "跨磁盘迁移，改用 robocopy…"
        nsExec::ExecToStack 'robocopy "$OldDir\data" "${DATADIR}" /E /MOVE /NFL /NDL /NJH /NJS /R:1 /W:1'
        Pop $1
        Pop $2
        ; robocopy reports 0-7 for success-with-flags; 8 and above are failures.
        ${If} $1 >= 8
          StrCpy $0 "迁移数据失败（robocopy 退出码 $1）。原数据仍在 $OldDir\data"
          Call InstallFail
        ${EndIf}
      ${EndIf}
      StrCpy $0 "数据迁移完成"
      Call LogLine
    ${Else}
      DetailPrint "旧目录里没有 data，跳过数据迁移。"
      StrCpy $0 "旧目录没有 data，跳过数据迁移"
      Call LogLine
    ${EndIf}

    ; The old copy's program files are superseded by the payload just written,
    ; so what remains is removed. `data` has already been moved away, so the
    ; helper — which deliberately skips `data` — cannot destroy it. Note the
    ; target is $OldDir, never $INSTDIR.
    IfFileExists "$OldDir\*.*" 0 old_clean_done
      DetailPrint "正在清理旧目录：$OldDir"
      StrCpy $R0 "$OldDir"
      Call RemoveProgramFilesAt
      ClearErrors
      RMDir "$OldDir"
      ${If} ${Errors}
        DetailPrint "注意：旧目录未能完全删除，可能还有文件残留：$OldDir"
        StrCpy $0 "警告: 旧目录未完全删除 $OldDir"
        Call LogLine
      ${EndIf}
    old_clean_done:

    ; The old registration is stale, and doubly so when the scope changed.
    ${If} $DesktopScope == "machine"
      DeleteRegKey HKLM "${UNINSTKEY}"
      DeleteRegKey HKLM "${REGKEY}"
    ${Else}
      DeleteRegKey HKCU "${UNINSTKEY}"
      DeleteRegKey HKCU "${REGKEY}"
    ${EndIf}
  ${EndIf}

  ; The data root. Its presence is what makes app/main.js keep everything
  ; beside the executable instead of under %APPDATA%; see app/data-root.js.
  CreateDirectory "${DATADIR}"
  CreateDirectory "${DATADIR}\dsh-home"
  CreateDirectory "${DATADIR}\shell"

  ; A plain-text explanation of the directory. Deliberately ASCII-only: FileWrite
  ; converts to the system ANSI codepage, so any non-ASCII byte here (and any
  ; non-ASCII install path, such as a Chinese user name) would be written as GBK
  ; and then be invalid UTF-8 for every JSON reader. Keeping it ASCII makes the
  ; file valid UTF-8 on every Windows locale. The Chinese explanation lives in
  ; 使用说明.txt instead, which is written by the build as UTF-8.
  IfFileExists "${DATADIR}\portable.json" done
    FileOpen $0 "${DATADIR}\portable.json" w
    FileWrite $0 "{$\r$\n"
    FileWrite $0 "  $\"note$\": $\"All DeepSeek Harness user data lives in this directory. Deleting it resets the app.$\",$\r$\n"
    FileWrite $0 "  $\"dsh-home$\": $\"dsh state (sessions, settings, credentials, plugins); this is DSH_HOME.$\",$\r$\n"
    FileWrite $0 "  $\"shell$\": $\"Desktop shell state (window position, logs, sign-in cookie).$\",$\r$\n"
    FileWrite $0 "  $\"appVersion$\": $\"${APPVERSION}$\"$\r$\n"
    FileWrite $0 "}$\r$\n"
    FileClose $0
  done:

  ; Registry: install location, scope, and Add/Remove Programs entry.
  ${If} $IsMachine == "1"
    WriteRegStr HKLM "${REGKEY}" "InstallDir" "$INSTDIR"
    WriteRegStr HKLM "${REGKEY}" "InstallMode" "machine"
    WriteRegStr HKLM "${REGKEY}" "Version" "${APPVERSION}"
    ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
    WriteRegDWORD HKLM "${UNINSTKEY}" "EstimatedSize" $0
    WriteRegStr HKLM "${UNINSTKEY}" "DisplayName" "${APPNAME}"
    WriteRegStr HKLM "${UNINSTKEY}" "DisplayVersion" "${APPVERSION}"
    WriteRegStr HKLM "${UNINSTKEY}" "Publisher" "${APPPUBLISHER}"
    WriteRegStr HKLM "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\${APPEXE}"
    WriteRegStr HKLM "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
    WriteRegStr HKLM "${UNINSTKEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
    WriteRegStr HKLM "${UNINSTKEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
    WriteRegDWORD HKLM "${UNINSTKEY}" "NoModify" 1
    WriteRegDWORD HKLM "${UNINSTKEY}" "NoRepair" 1
  ${Else}
    WriteRegStr HKCU "${REGKEY}" "InstallDir" "$INSTDIR"
    WriteRegStr HKCU "${REGKEY}" "InstallMode" "user"
    WriteRegStr HKCU "${REGKEY}" "Version" "${APPVERSION}"
    ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
    WriteRegDWORD HKCU "${UNINSTKEY}" "EstimatedSize" $0
    WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "${APPNAME}"
    WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${APPVERSION}"
    WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "${APPPUBLISHER}"
    WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\${APPEXE}"
    WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
    WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
    WriteRegStr HKCU "${UNINSTKEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
    WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
    WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
  ${EndIf}

  WriteUninstaller "$INSTDIR\uninstall.exe"
  ${IfNot} ${FileExists} "$INSTDIR\uninstall.exe"
    StrCpy $0 "无法写入卸载程序 uninstall.exe（目标目录可能只读）"
    Call InstallFail
  ${EndIf}

  StrCpy $0 "安装完成"
  Call LogLine
SectionEnd

Section "创建桌面快捷方式" SecDesktop
  CreateShortCut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\${APPEXE}" "" "$INSTDIR\${APPEXE}" 0
SectionEnd

Section "创建开始菜单快捷方式" SecStartMenu
  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortCut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" "$INSTDIR\${APPEXE}" "" "$INSTDIR\${APPEXE}" 0
  CreateShortCut "$SMPROGRAMS\${APPNAME}\卸载 ${APPNAME}.lnk" "$INSTDIR\uninstall.exe"
  CreateShortCut "$SMPROGRAMS\${APPNAME}\使用说明.lnk" "$INSTDIR\使用说明.txt"
SectionEnd

Section "让命令行 dsh 共用本目录的数据" SecEnvVar
  ; dsh resolves its home as: explicit config > $DSH_HOME > ~/.dsh. Pointing the
  ; variable here is what keeps the desktop app and a command-line `dsh` in
  ; agreement once the data no longer lives under the user profile.
  ${If} $IsMachine == "1"
    WriteRegExpandStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "DSH_HOME" "${DATADIR}\dsh-home"
  ${Else}
    WriteRegExpandStr HKCU "Environment" "DSH_HOME" "${DATADIR}\dsh-home"
  ${EndIf}
  ; Tell running programs (Explorer, shells) to re-read the environment.
  System::Call 'user32::SendMessageTimeoutW(i ${HWND_BROADCAST}, i ${WM_SETTINGCHANGE}, i 0, w "Environment", i 2, i 5000, *i .r0)'
SectionEnd

; ── section descriptions ────────────────────────────────────────────────────
!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecCore} "程序本体：Electron 运行时、内置 Node.js 与完整的 dsh 包。同时创建 data 数据目录。"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} "在桌面上放一个启动图标。"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecStartMenu} "在开始菜单里创建程序组（含卸载入口）。"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecEnvVar} "写入用户环境变量 DSH_HOME，使命令行 dsh 与桌面端读写同一份会话、设置与插件。取消勾选则命令行仍使用 %USERPROFILE%\.dsh。"
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; ── finish page ─────────────────────────────────────────────────────────────
Function LaunchApp
  ; An all-users install runs elevated; going through Explorer starts the app
  ; with normal user rights, which is what it should have.
  ${If} $IsMachine == "1"
    Exec '"$WINDIR\explorer.exe" "$INSTDIR\${APPEXE}"'
  ${Else}
    Exec '"$INSTDIR\${APPEXE}"'
  ${EndIf}
FunctionEnd

; ── uninstall ───────────────────────────────────────────────────────────────
Var UnMode
Var UnHive
; Whether to delete the data directory as well. This needs a named variable:
; un.RemoveProgramFiles uses $1 as its FindFirst/FindNext handle, so keeping the
; flag in $1 meant it was destroyed before it was ever tested and /DELETE_DATA
; silently never deleted anything.
Var UnDeleteData

Section "Uninstall"
  ; Which scope installed this? The uninstaller is a separate process, so it
  ; reads back what the installer recorded.
  ReadRegStr $UnMode HKCU "${REGKEY}" "InstallMode"
  ${If} $UnMode == "machine"
    StrCpy $UnHive "HKLM"
  ${Else}
    ReadRegStr $UnMode HKLM "${REGKEY}" "InstallMode"
    ${If} $UnMode == "machine"
      StrCpy $UnHive "HKLM"
    ${Else}
      StrCpy $UnHive "HKCU"
    ${EndIf}
  ${EndIf}

  ; An uninstaller's $INSTDIR defaults to the folder the uninstaller is *run
  ; from*, which is not necessarily where the app was installed: copy
  ; uninstall.exe to another folder, run it there, and NSIS happily deletes that
  ; folder instead. (Measured — it wiped this project's whole scratch tree during
  ; acceptance testing.) So the directory the installer recorded wins, and
  ; $EXEDIR is only a fallback for an install whose key is already gone.
  ; This must happen before the DeleteRegKey calls below.
  ${If} $UnHive == "HKLM"
    ReadRegStr $0 HKLM "${REGKEY}" "InstallDir"
  ${Else}
    ReadRegStr $0 HKCU "${REGKEY}" "InstallDir"
  ${EndIf}
  ${If} $0 != ""
    StrCpy $INSTDIR "$0"
  ${EndIf}

  ${If} $UnHive == "HKLM"
    SetShellVarContext all
    DeleteRegKey HKLM "${UNINSTKEY}"
    DeleteRegKey HKLM "${REGKEY}"
  ${Else}
    SetShellVarContext current
    DeleteRegKey HKCU "${UNINSTKEY}"
    DeleteRegKey HKCU "${REGKEY}"
  ${EndIf}

  Delete "$DESKTOP\${APPNAME}.lnk"
  Delete "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk"
  Delete "$SMPROGRAMS\${APPNAME}\卸载 ${APPNAME}.lnk"
  Delete "$SMPROGRAMS\${APPNAME}\使用说明.lnk"
  RMDir "$SMPROGRAMS\${APPNAME}"

  ; Withdraw the DSH_HOME override, but only when it points at this install:
  ; the user may have set the variable themselves for another copy.
  ${If} $UnHive == "HKLM"
    ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "DSH_HOME"
    ${If} $0 == "${DATADIR}\dsh-home"
      DeleteRegValue HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "DSH_HOME"
      System::Call 'user32::SendMessageTimeoutW(i ${HWND_BROADCAST}, i ${WM_SETTINGCHANGE}, i 0, w "Environment", i 2, i 5000, *i .r0)'
    ${EndIf}
  ${Else}
    ReadRegStr $0 HKCU "Environment" "DSH_HOME"
    ${If} $0 == "${DATADIR}\dsh-home"
      DeleteRegValue HKCU "Environment" "DSH_HOME"
      System::Call 'user32::SendMessageTimeoutW(i ${HWND_BROADCAST}, i ${WM_SETTINGCHANGE}, i 0, w "Environment", i 2, i 5000, *i .r0)'
    ${EndIf}
  ${EndIf}

  ; Data is kept by default: it holds the user's sessions and credentials.
  ; A silent uninstall must neither block on a prompt nor destroy data, so it
  ; keeps the directory unless `/DELETE_DATA` is passed explicitly.
  StrCpy $UnDeleteData "0"
  IfFileExists "${DATADIR}\*.*" 0 data_done
  ${If} ${Silent}
    ${un.GetParameters} $2
    ${UnStrStr} $3 "$2" "/DELETE_DATA"
    ${If} $3 != ""
      StrCpy $UnDeleteData "1"
    ${EndIf}
  ${Else}
    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 \
      "是否同时删除数据目录？$\r$\n$\r$\n${DATADIR}$\r$\n$\r$\n其中包含你的会话、设置、凭据与插件。删除后无法恢复。" \
      IDYES data_yes
    Goto data_done
    data_yes:
    StrCpy $UnDeleteData "1"
  ${EndIf}
  data_done:

  DetailPrint "正在删除程序文件…"
  Call un.RemoveProgramFiles
  ; Tested only after RemoveProgramFiles, which is why the flag cannot live in a
  ; numbered register that the function reuses as its directory-enumeration handle.
  ${If} $UnDeleteData == "1"
    RMDir /r "${DATADIR}"
  ${EndIf}
  RMDir "$INSTDIR"

  ${If} $UnDeleteData == "1"
    DetailPrint "程序与数据均已删除。"
  ${Else}
    DetailPrint "程序已删除，数据保留在 ${DATADIR}"
  ${EndIf}
SectionEnd

; Remove every file and directory under $R0 except `data`.
;
; Its target is an explicit variable rather than $INSTDIR on purpose: the
; installer calls it to clean up a directory it has just migrated *away from*,
; and reading $INSTDIR there would delete the files it just installed.
Function RemoveProgramFilesAt
  ClearErrors
  FindFirst $0 $1 "$R0\*.*"
  loop:
    StrCmp $1 "" done
    StrCmp $1 "." next
    StrCmp $1 ".." next
    StrCmp $1 "data" next
    IfFileExists "$R0\$1\*.*" 0 remove_file
      RMDir /r "$R0\$1"
      Goto next
    remove_file:
      Delete "$R0\$1"
  next:
    FindNext $0 $1
    Goto loop
  done:
  FindClose $0
FunctionEnd

Function un.RemoveProgramFiles
  ClearErrors
  FindFirst $0 $1 "$INSTDIR\*.*"
  un_loop:
    StrCmp $1 "" un_done
    StrCmp $1 "." un_next
    StrCmp $1 ".." un_next
    StrCmp $1 "data" un_next
    IfFileExists "$INSTDIR\$1\*.*" 0 un_file
      RMDir /r "$INSTDIR\$1"
      Goto un_next
    un_file:
      Delete "$INSTDIR\$1"
  un_next:
    FindNext $0 $1
    Goto un_loop
  un_done:
  FindClose $0
FunctionEnd
