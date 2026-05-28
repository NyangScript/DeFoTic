# build-android.ps1
# Script to build and sign the DeFoTic React Native Android App for Release

# Exit immediately if any command fails
$ErrorActionPreference = "Stop"

# 1. Run Expo prebuild to generate/update the android directory
Write-Host "Step 1: Running Expo Prebuild..." -ForegroundColor Cyan
npx expo prebuild --platform android

# 2. Check keystore location
$KeystoreName = "my-release-key.jks"
$KeystorePath = ""

if (Test-Path "$PSScriptRoot\$KeystoreName") {
    $KeystorePath = "$PSScriptRoot\$KeystoreName"
} elseif (Test-Path "$PSScriptRoot\android\$KeystoreName") {
    $KeystorePath = "$PSScriptRoot\android\$KeystoreName"
} else {
    Write-Warning "Keystore file '$KeystoreName' not found in project root or android directory."
    Write-Warning "Please place your '$KeystoreName' file in the project root."
    # We will assume it's in the root for the rest of the commands
    $KeystorePath = "$PSScriptRoot\$KeystoreName"
}

Write-Host "Using keystore: $KeystorePath" -ForegroundColor Green

# 3. Change directory to android and compile
Write-Host "Step 2: Building Release APK..." -ForegroundColor Cyan
Push-Location android

try {
    .\gradlew.bat assembleRelease
}
catch {
    Write-Error "Gradle build failed."
    Pop-Location
    exit 1
}

# 4. Define paths relative to the android directory
$ApkDir = "app\build\outputs\apk\release"
$OriginalApk = "$ApkDir\app-release.apk"
$UnsignedApk = "$ApkDir\app-release-unsigned.apk"
$AlignedApk = "$ApkDir\app-release-aligned.apk"

# 5. Copy APK
Write-Host "Step 3: Copying APK..." -ForegroundColor Cyan
if (Test-Path $OriginalApk) {
    Copy-Item -Path $OriginalApk -Destination $UnsignedApk -Force
} else {
    Write-Error "Could not find built APK at $OriginalApk"
    Pop-Location
    exit 1
}

# 6. Sign with jarsigner
Write-Host "Step 4: Signing with jarsigner..." -ForegroundColor Cyan
jarsigner -verbose -sigalg SHA256withRSA -digestalg SHA-256 `
  -keystore "$KeystorePath" `
  -storepass defotic2026 `
  -keypass defotic2026 `
  $UnsignedApk `
  my-key-alias

# 7. Zipalign
Write-Host "Step 5: Running zipalign..." -ForegroundColor Cyan
$ZipalignPath = "C:\Users\user\AppData\Local\Android\Sdk\build-tools\35.0.0\zipalign.exe"
if (-not (Test-Path $ZipalignPath)) {
    # Fallback: check if in system PATH
    $ZipalignPath = Get-Command zipalign -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
}

if (-not $ZipalignPath) {
    Write-Error "zipalign.exe not found at $ZipalignPath or in system PATH."
    Pop-Location
    exit 1
}

& $ZipalignPath -f -v 4 $UnsignedApk $AlignedApk

# 8. Apksigner sign
Write-Host "Step 6: Signing with apksigner..." -ForegroundColor Cyan
$ApksignerPath = "C:\Users\user\AppData\Local\Android\Sdk\build-tools\35.0.0\apksigner.bat"
if (-not (Test-Path $ApksignerPath)) {
    # Fallback: check if in system PATH
    $ApksignerPath = Get-Command apksigner -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
}

if (-not $ApksignerPath) {
    Write-Error "apksigner.bat not found at $ApksignerPath or in system PATH."
    Pop-Location
    exit 1
}

& $ApksignerPath sign `
  --ks "$KeystorePath" `
  --ks-key-alias my-key-alias `
  --ks-pass pass:defotic2026 `
  --key-pass pass:defotic2026 `
  $AlignedApk

Write-Host "`nSuccessfully built and signed release APK!" -ForegroundColor Green
Write-Host "Final signed APK is located at: android\$AlignedApk" -ForegroundColor Green

Pop-Location
