param([Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$TargetProcessId)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
    $roonProcess = Get-Process -Id $TargetProcessId -ErrorAction Stop
    $executablePath = $roonProcess.Path
    if ([string]::IsNullOrWhiteSpace($executablePath)) {
        # Process.MainModule can be inaccessible across process architectures;
        # this read-only query needs only PROCESS_QUERY_LIMITED_INFORMATION.
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class RoonDesktopProcessQuery {
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref int size);
    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr handle);
}
'@
        $processHandle = [RoonDesktopProcessQuery]::OpenProcess(0x1000, $false, $TargetProcessId)
        if ($processHandle -eq [IntPtr]::Zero) { throw 'Process identity unavailable.' }
        try {
            $pathBuffer = [System.Text.StringBuilder]::new(32768)
            $pathLength = $pathBuffer.Capacity
            if (-not [RoonDesktopProcessQuery]::QueryFullProcessImageName($processHandle, 0, $pathBuffer, [ref]$pathLength)) {
                throw 'Process path query failed.'
            }
            $executablePath = $pathBuffer.ToString()
        } finally { [void][RoonDesktopProcessQuery]::CloseHandle($processHandle) }
    }
    [ordered]@{
        pid = $roonProcess.Id
        path = $executablePath
        started_at = $roonProcess.StartTime.ToUniversalTime().ToString('o')
    } | ConvertTo-Json -Compress
} catch {
    [Console]::Error.WriteLine('The selected process identity could not be verified.')
    exit 1
}
