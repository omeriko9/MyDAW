' MyDAW portable stub — runs the PowerShell launcher with NO console window.
' (IExpress launches this after extracting to its temp dir; powershell.exe with
' -WindowStyle Hidden still flashes a console for a frame, wscript does not.)
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & base & "\launch.ps1""", 0, True
