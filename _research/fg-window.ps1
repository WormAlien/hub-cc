# Заголовок окна, которое СЕЙЧАС в фокусе. Только ASCII: правило кодировок для .ps1 -
# UTF-8 с BOM при запуске файлом, но проще не иметь кириллицы вовсе.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class FgWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
}
"@
$h = [FgWin]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 256
[void][FgWin]::GetWindowText($h, $sb, 256)
Write-Output $sb.ToString()
