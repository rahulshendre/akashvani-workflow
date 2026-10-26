; ============================================================================
;  Akashvani Workflow — Inno Setup script
;
;  Produces dist-installer\AkashvaniSetup.exe which installs the bundled
;  Node-server / React-frontend / FFmpeg payload to Program Files, creates
;  Start Menu shortcuts, and registers an uninstaller.
;
;  Build via:    npm run build:installer:setup
;  Manual build: "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer\akashvani.iss
;
;  Prerequisites: `npm run build:installer` must have produced dist-server\
;  with Akashvani.exe, frontend\, and ffmpeg\. The [Files] section below
;  refers to those paths relative to the project root, so the script is
;  invoked WITH that root as the working directory.
; ============================================================================

#define AppName "Akashvani Workflow"
#define AppVersion "0.1.1"
#define AppPublisher "Akashvani"
#define AppExeName "Akashvani.exe"
; Stable, randomly-generated GUID. Changing this breaks upgrade detection,
; so it must stay constant across releases.
#define AppId "{{F4B3E2C7-9C1A-4D5F-AE8B-6F7C2A1E4D90}"

; ── API keys, supplied at BUILD time ────────────────────────────────────────
; Passed in by scripts/build-installer.mjs as /DSarvamApiKey=... and
; /DAnthropicApiKey=...  Both are read from the environment or server\.env, so
; neither key goes into this repository — only into the installer it builds.
;
; Left undefined, the installer still builds; that feature is simply off until
; someone edits config.env on the machine.
;
;   Sarvam    -> automatic subtitle generation from the episode audio
;   Anthropic -> converting the finished subtitles to Roman script
#ifndef GoogleClientId
  #define GoogleClientId ""
#endif
#ifndef GoogleClientSecret
  #define GoogleClientSecret ""
#endif
#ifndef SarvamApiKey
  #define SarvamApiKey ""
#endif
#ifndef AnthropicApiKey
  #define AnthropicApiKey ""
#endif

; Confirms at compile time whether each key actually arrived, without printing
; it. The installer is compressed, so there is no way to check the finished
; .exe by eye — these lines are the only build-time evidence either way.
#if Len(GoogleClientSecret) > 0
  #pragma message "Google client secret received: " + Str(Len(GoogleClientSecret)) + " chars"
#else
  #pragma message "NO Google credentials — Drive upload will be off until config.env is edited"
#endif
#if Len(SarvamApiKey) > 0
  #pragma message "Sarvam key received: " + Str(Len(SarvamApiKey)) + " chars"
#else
  #pragma message "NO Sarvam key — automatic subtitles will be off until config.env is edited"
#endif
#if Len(AnthropicApiKey) > 0
  #pragma message "Anthropic key received: " + Str(Len(AnthropicApiKey)) + " chars"
#else
  #pragma message "NO Anthropic key — Roman script will be off until config.env is edited"
#endif

[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL=
AppSupportURL=
AppUpdatesURL=
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\{#AppExeName}
UninstallDisplayName={#AppName}
OutputDir=..\dist-installer
OutputBaseFilename=AkashvaniSetup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
; FFmpeg binaries we ship are 64-bit Windows. Refuse to install on anything else.
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; A short note shown on the welcome page
AppComments=Local video pipeline — compression, watermark, SRT, Drive upload
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Files]
; ── core executable ────────────────────────────────────────────────────────
Source: "..\dist-server\{#AppExeName}"; DestDir: "{app}"; Flags: ignoreversion

; ── React frontend (preserve directory tree under frontend\) ───────────────
Source: "..\dist-server\frontend\*"; DestDir: "{app}\frontend"; Flags: ignoreversion recursesubdirs createallsubdirs

; ── bundled FFmpeg binaries ────────────────────────────────────────────────
Source: "..\dist-server\ffmpeg\*"; DestDir: "{app}\ffmpeg"; Flags: ignoreversion

; ── bundled runtime resources (watermark, etc.) ────────────────────────────
Source: "..\dist-server\resources\*"; DestDir: "{app}\resources"; Flags: ignoreversion recursesubdirs createallsubdirs

; ── config.env — ONLY install on fresh install, never overwrite user's edits
Source: "config.env.template"; DestDir: "{app}"; DestName: "config.env"; Flags: onlyifdoesntexist uninsneveruninstall

; ── plaintext first-run instructions, opened post-install ──────────────────
Source: "First-run-setup.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}";                         Filename: "{app}\{#AppExeName}"
Name: "{group}\First-run setup instructions";       Filename: "{app}\First-run-setup.txt"
Name: "{group}\Edit configuration (config.env)";    Filename: "notepad.exe"; Parameters: """{app}\config.env"""
Name: "{group}\View logs folder";                   Filename: "{localappdata}\{#AppName}\logs"
Name: "{group}\Open application log";               Filename: "notepad.exe"; Parameters: """{localappdata}\{#AppName}\logs\akashvani.log"""
Name: "{group}\Uninstall {#AppName}";               Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}";                   Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Run]
; After a successful install, two optional checkboxes on the last wizard page:
;   1. View the plain-text "Getting Started" walkthrough
;   2. Launch the app — defaults to checked, so most users go straight in
; No Notepad-edits-config.env step: Google credentials and the watermark image
; are pre-bundled. There is nothing the user needs to edit.
Filename: "notepad.exe"; Parameters: """{app}\First-run-setup.txt"""; Description: "View Getting Started"; Flags: nowait postinstall skipifsilent unchecked
Filename: "{app}\{#AppExeName}"; Description: "Launch {#AppName} now"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; Stop a running instance before removing files (best-effort, ignore errors).
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM {#AppExeName}"; Flags: runhidden; RunOnceId: "KillAkashvani"


[Code]
// Put the build-time API keys into config.env so the features that need them
// work on a machine nobody has configured by hand.
//
// This cannot be done by shipping a filled-in config.env, because that file is
// installed with `onlyifdoesntexist` to protect each office's own Drive and
// watermark settings — so on every EXISTING install the file is left alone and
// a pre-filled copy would never arrive. Editing it here is what reaches those
// machines, which is all of them.
//
// Only ever fills a BLANK key. A value someone deliberately typed is left as
// it is, and no other line in the file is touched.
//
// Returns True when the file needs saving.
function FillBlankKey(var Lines: TArrayOfString; Name, Value: String): Boolean;
var
  Prefix, Trimmed: String;
  i, Count: Integer;
  Found: Boolean;
begin
  Result := False;
  if Trim(Value) = '' then
    Exit;

  Prefix := Name + '=';
  Found := False;
  Count := GetArrayLength(Lines);

  for i := 0 to Count - 1 do
  begin
    Trimmed := Trim(Lines[i]);
    if Copy(Trimmed, 1, Length(Prefix)) = Prefix then
    begin
      Found := True;
      if Trim(Copy(Trimmed, Length(Prefix) + 1, Length(Trimmed))) = '' then
      begin
        Lines[i] := Prefix + Value;
        Result := True;
      end;
    end;
  end;

  // Upgrading from a build whose config.env predates this setting entirely.
  if not Found then
  begin
    SetArrayLength(Lines, Count + 2);
    Lines[Count] := '';
    Lines[Count + 1] := Prefix + Value;
    Result := True;
  end;
end;

procedure EnsureApiKeys();
var
  ConfigPath: String;
  Lines: TArrayOfString;
  Changed: Boolean;
begin
  ConfigPath := ExpandConstant('{app}\config.env');
  if not FileExists(ConfigPath) then
    Exit;
  if not LoadStringsFromFile(ConfigPath, Lines) then
    Exit;

  // Separate statements, not `A or B`: Pascal short-circuits, so combining them
  // would skip later keys whenever an earlier one already filled something.
  Changed := FillBlankKey(Lines, 'GOOGLE_CLIENT_ID', '{#GoogleClientId}');
  if FillBlankKey(Lines, 'GOOGLE_CLIENT_SECRET', '{#GoogleClientSecret}') then
    Changed := True;
  if FillBlankKey(Lines, 'SARVAM_API_KEY', '{#SarvamApiKey}') then
    Changed := True;
  if FillBlankKey(Lines, 'ANTHROPIC_API_KEY', '{#AnthropicApiKey}') then
    Changed := True;

  if Changed then
    // Deliberately not logged — SetupLogging is on and the log is copied into
    // the app's log folder, which would put the keys in a file support reads.
    SaveStringsToFile(ConfigPath, Lines, False);
end;

// Inno writes its own setup log to %TEMP%. Copy it into the app's log folder so
// that ONE folder holds both the install record and the runtime log — support
// only ever has to ask for a single place, on every machine.
procedure CurStepChanged(CurStep: TSetupStep);
var
  LogDir: String;
begin
  if CurStep = ssPostInstall then
  begin
    EnsureApiKeys();

    LogDir := ExpandConstant('{localappdata}\{#AppName}\logs');
    if not DirExists(LogDir) then
      ForceDirectories(LogDir);
    // Best effort: a failure to copy the log must never fail the install.
    FileCopy(ExpandConstant('{log}'), LogDir + '\install.log', False);
  end;
end;
