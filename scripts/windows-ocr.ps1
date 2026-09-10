[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ImagePath,

    [Parameter()]
    [string]$LanguagesJson = '["zh-Hant","en-US"]'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$DebugPreference = 'SilentlyContinue'
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $OutputEncoding

function Write-OcrJson {
    param([Parameter(Mandatory = $true)][object]$Value)

    [Console]::Out.Write(($Value | ConvertTo-Json -Depth 8 -Compress))
}

function Write-Unavailable {
    param([Parameter(Mandatory = $true)][string]$Error)

    Write-OcrJson ([ordered]@{
            available = $false
            error = $Error
        })
}

function Await-WinRtOperation {
    param(
        [Parameter(Mandatory = $true)][object]$Operation,
        [Parameter(Mandatory = $true)][Type]$ResultType
    )

    $asTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object {
            $_.Name -eq 'AsTask' -and
            $_.IsGenericMethodDefinition -and
            $_.GetGenericArguments().Count -eq 1 -and
            $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        } |
        Select-Object -First 1

    if ($null -eq $asTaskMethod) {
        throw 'Windows Runtime async support is unavailable.'
    }

    $task = $asTaskMethod.MakeGenericMethod([Type[]]@($ResultType)).Invoke($null, @($Operation))
    return $task.GetAwaiter().GetResult()
}

function Get-SourceBounds {
    param(
        [Parameter(Mandatory = $true)][object]$Rect,
        [Parameter(Mandatory = $true)][double]$ScaleX,
        [Parameter(Mandatory = $true)][double]$ScaleY
    )

    return [ordered]@{
        x = [Math]::Round(([double]$Rect.X * $ScaleX), 4)
        y = [Math]::Round(([double]$Rect.Y * $ScaleY), 4)
        width = [Math]::Round(([double]$Rect.Width * $ScaleX), 4)
        height = [Math]::Round(([double]$Rect.Height * $ScaleY), 4)
    }
}

function Get-CombinedBounds {
    param([Parameter(Mandatory = $true)][object[]]$Words)

    if ($Words.Count -eq 0) {
        return [ordered]@{ x = 0; y = 0; width = 0; height = 0 }
    }

    $left = [double]::PositiveInfinity
    $top = [double]::PositiveInfinity
    $right = [double]::NegativeInfinity
    $bottom = [double]::NegativeInfinity
    foreach ($word in $Words) {
        $bounds = $word.bounds
        $left = [Math]::Min($left, [double]$bounds.x)
        $top = [Math]::Min($top, [double]$bounds.y)
        $right = [Math]::Max($right, [double]$bounds.x + [double]$bounds.width)
        $bottom = [Math]::Max($bottom, [double]$bounds.y + [double]$bounds.height)
    }

    return [ordered]@{
        x = [Math]::Round($left, 4)
        y = [Math]::Round($top, 4)
        width = [Math]::Round(($right - $left), 4)
        height = [Math]::Round(($bottom - $top), 4)
    }
}

function Prepare-OcrImage {
    param([Parameter(Mandatory = $true)][string]$Path)

    Add-Type -AssemblyName System.Drawing
    $image = [System.Drawing.Image]::FromFile($Path, $false)
    try {
        $sourceWidth = [int]$image.Width
        $sourceHeight = [int]$image.Height
        if ($sourceWidth -le 0 -or $sourceHeight -le 0) {
            throw 'The image has invalid dimensions.'
        }

        $maximum = [int][Windows.Media.Ocr.OcrEngine]::MaxImageDimension
        # Small, light Chinese sidebar labels benefit from a 2x recognition
        # image. Returned rectangles are always remapped to source pixels.
        $longestSide = [Math]::Max($sourceWidth, $sourceHeight)
        $preferredScale = if ($longestSide -le 2500) { 2.0 } else { 1.0 }
        $scale = [Math]::Min($preferredScale, [double]$maximum / [double]$longestSide)
        if ([Math]::Abs($scale - 1.0) -lt 0.0001) {
            return [ordered]@{
                path = $Path
                temporaryPath = $null
                sourceWidth = $sourceWidth
                sourceHeight = $sourceHeight
                workingWidth = $sourceWidth
                workingHeight = $sourceHeight
            }
        }

        $workingWidth = [Math]::Max(1, [int][Math]::Round($sourceWidth * $scale))
        $workingHeight = [Math]::Max(1, [int][Math]::Round($sourceHeight * $scale))
        $temporaryPath = Join-Path ([System.IO.Path]::GetTempPath()) ("roon-ocr-$([Guid]::NewGuid().ToString('N')).png")

        $resized = New-Object System.Drawing.Bitmap($workingWidth, $workingHeight)
        try {
            $graphics = [System.Drawing.Graphics]::FromImage($resized)
            try {
                $graphics.Clear([System.Drawing.Color]::White)
                $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
                $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
                $graphics.DrawImage($image, (New-Object System.Drawing.Rectangle(0, 0, $workingWidth, $workingHeight)))
                $resized.Save($temporaryPath, [System.Drawing.Imaging.ImageFormat]::Png)
            }
            finally {
                $graphics.Dispose()
            }
        }
        finally {
            $resized.Dispose()
        }

        return [ordered]@{
            path = $temporaryPath
            temporaryPath = $temporaryPath
            sourceWidth = $sourceWidth
            sourceHeight = $sourceHeight
            workingWidth = $workingWidth
            workingHeight = $workingHeight
        }
    }
    finally {
        $image.Dispose()
    }
}

$prepared = $null
$stream = $null
$bitmap = $null
$stage = 'initializing Windows OCR'

try {
    if (-not (Test-Path -LiteralPath $ImagePath -PathType Leaf)) {
        Write-Unavailable 'Image file was not found or is not a file.'
        exit 0
    }

    $resolvedImagePath = [System.IO.Path]::GetFullPath($ImagePath)
    $parsedLanguages = ConvertFrom-Json -InputObject $LanguagesJson -ErrorAction Stop
    $languages = @(
        foreach ($candidate in @($parsedLanguages)) {
            if ($candidate -is [string] -and -not [string]::IsNullOrWhiteSpace($candidate)) {
                $candidate.Trim()
            }
        }
    )
    if ($languages.Count -eq 0) {
        Write-Unavailable 'At least one OCR language is required.'
        exit 0
    }

    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
    $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrResult, Windows.Media.Ocr, ContentType = WindowsRuntime]
    $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

    $engine = $null
    $selectedLanguage = $null
    foreach ($languageTag in $languages) {
        try {
            $candidateLanguage = New-Object Windows.Globalization.Language($languageTag)
            $candidateEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($candidateLanguage)
            if ($null -ne $candidateEngine) {
                $engine = $candidateEngine
                $selectedLanguage = $candidateLanguage.LanguageTag
                break
            }
        }
        catch {
            # Try the next explicitly requested language.
        }
    }

    if ($null -eq $engine) {
        Write-Unavailable 'No requested Windows OCR language is installed.'
        exit 0
    }

    $stage = 'preparing the image'
    $prepared = Prepare-OcrImage -Path $resolvedImagePath
    $stage = 'opening the image'
    $storageFile = Await-WinRtOperation -Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($prepared.path)) -ResultType ([Windows.Storage.StorageFile])
    $stream = Await-WinRtOperation -Operation ($storageFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)) -ResultType ([Windows.Storage.Streams.IRandomAccessStream])
    $stage = 'decoding the image'
    $decoder = Await-WinRtOperation -Operation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) -ResultType ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await-WinRtOperation -Operation ($decoder.GetSoftwareBitmapAsync()) -ResultType ([Windows.Graphics.Imaging.SoftwareBitmap])

    if ($bitmap.BitmapPixelFormat -ne [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8 -and $bitmap.BitmapPixelFormat -ne [Windows.Graphics.Imaging.BitmapPixelFormat]::Gray8) {
        $convertedBitmap = [Windows.Graphics.Imaging.SoftwareBitmap]::Convert($bitmap, [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8)
        $bitmap.Dispose()
        $bitmap = $convertedBitmap
    }

    $stage = 'recognizing text'
    $ocrResult = Await-WinRtOperation -Operation ($engine.RecognizeAsync($bitmap)) -ResultType ([Windows.Media.Ocr.OcrResult])
    $scaleX = [double]$prepared.sourceWidth / [double]$prepared.workingWidth
    $scaleY = [double]$prepared.sourceHeight / [double]$prepared.workingHeight
    $stage = 'formatting recognition results'
    $lines = @(
        foreach ($line in $ocrResult.Lines) {
            $words = @(
                foreach ($word in $line.Words) {
                    [ordered]@{
                        text = [string]$word.Text
                        bounds = Get-SourceBounds -Rect $word.BoundingRect -ScaleX $scaleX -ScaleY $scaleY
                    }
                }
            )
            [ordered]@{
                text = [string]$line.Text
                bounds = (Get-CombinedBounds -Words $words)
                words = $words
            }
        }
    )

    Write-OcrJson ([ordered]@{
            available = $true
            language = $selectedLanguage
            text = [string]$ocrResult.Text
            lines = $lines
            width = $prepared.sourceWidth
            height = $prepared.sourceHeight
        })
}
catch {
    Write-Unavailable ("Windows OCR failed while ${stage}.")
}
finally {
    if ($null -ne $bitmap) {
        try { $bitmap.Dispose() } catch { }
    }
    if ($null -ne $stream) {
        try { $stream.Dispose() } catch { }
    }
    if ($null -ne $prepared -and $null -ne $prepared.temporaryPath) {
        try { Remove-Item -LiteralPath $prepared.temporaryPath -Force -ErrorAction SilentlyContinue } catch { }
    }
}
